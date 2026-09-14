import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSmsAdminHandler } from "../../../src/next/index.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";

const admin = { id: "admin-1", tenantId: "tenant-a" as AuthorizationActor["tenantId"], permissions: ["resource.sync", "config.read", "signature.manage", "template.manage"] } as const;
const syncId = "00000000-0000-4000-8000-000000000001";
const candidateId = "00000000-0000-4000-8000-000000000002";
const signatureId = "00000000-0000-4000-8000-000000000003";
const templateId = "00000000-0000-4000-8000-000000000004";
const candidate = { id: candidateId, resourceType: "signature" as const, externalKey: "aliyun:sign:notice", changeType: "new" as const, checksum: "checksum-1", snapshot: { kind: "signature" as const, externalName: "Notice", externalStatus: "approved", externalType: "normal" } };

function handlerFor(task3: unknown) {
  return createSmsAdminHandler({
    resolveActor: async () => admin, resolveTrustedIp: () => "203.0.113.9",
    authorizer: { assert: () => undefined, assertAny: () => undefined }, services: { task3 } as never,
    ids: { next: () => "req-1", messageId: () => "message-1" as never },
  });
}

describe("sms resource routes", () => {
  it("returns conflict for an expired sync preview without exposing the snapshot", async () => {
    const handler = handlerFor({ resourceSync: { commit: async () => { throw new SmsKitError("CONCURRENT_MODIFICATION", "preview expired"); } } });
    const response = await handler(new Request("https://app.test/api/admin/sms/resources/sync-commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, idempotencyKey: "sync:1", syncId, candidates: [{ id: candidateId, checksum: "checksum-1" }] }),
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: { code: "CONCURRENT_MODIFICATION" } });
    expect(JSON.stringify(body)).not.toContain("preview expired");
  });

  it("serializes preview candidates with one server expiry and accepts strict pagination", async () => {
    const handler = handlerFor({
      resourceSync: { preview: async () => ({ id: "sync-1", status: "running", expiresAt: new Date("2026-09-15T00:00:00.000Z"), candidates: [candidate] }) },
      resources: { listSignatures: async () => ({ items: [{ id: "signature-1", externalKey: "aliyun:sign:notice", externalName: "Notice", externalStatus: "approved", externalType: "normal", enabled: true, version: 2 }], total: 1 }) },
    });
    const preview = await handler(new Request("https://app.test/api/admin/sms/resources/sync-preview", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, idempotencyKey: "sync:preview" }),
    }));
    const signatures = await handler(new Request("https://app.test/api/admin/sms/signatures?page=1&pageSize=1"));
    const invalidPage = await handler(new Request("https://app.test/api/admin/sms/signatures?page=1&pageSize=101"));

    expect(preview.status).toBe(200);
    expect((await preview.json()).data.candidates[0]).toMatchObject({ checksum: "checksum-1", expiresAt: "2026-09-15T00:00:00.000Z" });
    expect(signatures.status).toBe(200);
    expect((await signatures.json()).data).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    expect(invalidPage.status).toBe(400);
  });

  it("passes the trusted actor to built-in global resource list services", async () => {
    let receivedActor: unknown;
    let receivedPage: unknown;
    const handler = handlerFor({
      resources: {
        listSignatures: async (actor: unknown, page: unknown) => {
          receivedActor = actor;
          receivedPage = page;
          return { items: [], total: 0 };
        },
      },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/signatures?page=2&pageSize=5"));

    expect(response.status).toBe(200);
    expect(receivedActor).toMatchObject({ id: "admin-1", tenantId: "tenant-a" });
    expect(receivedPage).toEqual({ page: 2, pageSize: 5 });
  });

  it("maps versioned sync metadata to the application service without dropping it", async () => {
    let previewInput: unknown;
    let commitInput: unknown;
    const handler = handlerFor({
      resourceSync: {
        preview: async (_actor: unknown, input: unknown) => {
          previewInput = input;
          return { id: "sync-1", status: "running", expiresAt: new Date("2026-09-15T00:00:00.000Z"), candidates: [candidate] };
        },
        commit: async (_actor: unknown, input: unknown) => {
          commitInput = input;
          return { id: "sync-1", status: "succeeded", expiresAt: new Date("2026-09-15T00:00:00.000Z"), candidates: [candidate] };
        },
      },
    });

    const preview = await handler(new Request("https://app.test/api/admin/sms/resources/sync-preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 7, idempotencyKey: "sync:preview", pageSize: 25 }),
    }));
    const commit = await handler(new Request("https://app.test/api/admin/sms/resources/sync-commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 7, idempotencyKey: "sync:commit", syncId, candidates: [{ id: candidateId, checksum: "checksum-1" }] }),
    }));

    expect(preview.status).toBe(200);
    expect(commit.status).toBe(200);
    expect(previewInput).toEqual({ pageSize: 25, expectedVersion: 7, idempotencyKey: "sync:preview" });
    expect(commitInput).toEqual({
      syncId, candidates: [{ id: candidateId, checksum: "checksum-1" }],
      expectedVersion: 7, idempotencyKey: "sync:commit",
    });
  });

  it("maps resource mutations by id and reports an immutable used template key as a safe conflict", async () => {
    const handler = handlerFor({
      resources: {
        updateSignature: async (_actor: unknown, input: { id: string; enabled: boolean; version: number }) => ({ id: input.id, externalKey: "aliyun:sign:notice", externalName: "Notice", externalStatus: "approved", externalType: "normal", enabled: input.enabled, version: input.version + 1 }),
        updateTemplate: async () => { throw new SmsKitError("CONCURRENT_MODIFICATION", "stable key is used by a sent message"); },
      },
    });
    const signature = await handler(new Request(`https://app.test/api/admin/sms/signatures/${signatureId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 2, idempotencyKey: "signature:disable", enabled: false }),
    }));
    const rename = await handler(new Request(`https://app.test/api/admin/sms/templates/${templateId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 3, idempotencyKey: "template:rename", templateKey: "notice.renamed" }),
    }));
    const renameBody = await rename.json();

    expect(signature.status).toBe(200);
    expect(await signature.json()).toMatchObject({ data: { id: signatureId, enabled: false, version: 3 } });
    expect(rename.status).toBe(409);
    expect(renameBody).toMatchObject({ error: { code: "CONCURRENT_MODIFICATION", message: "concurrent modification" } });
    expect(JSON.stringify(renameBody)).not.toContain("sent message");
  });

  it("rejects malformed PostgreSQL resource identifiers before a service can bind them", async () => {
    let calls = 0;
    const handler = handlerFor({
      resourceSync: { commit: async () => { calls += 1; return { id: syncId, status: "succeeded", expiresAt: new Date("2026-09-15T00:00:00.000Z"), candidates: [] }; } },
      resources: {
        updateSignature: async () => { calls += 1; return { id: signatureId, externalKey: "sign", externalName: "Sign", externalStatus: "approved", externalType: "text", enabled: true, version: 2 }; },
        updateTemplate: async () => { calls += 1; return { id: templateId, signatureId, templateKey: "notice.valid", externalCode: "SMS_VALID", externalName: "Valid", externalStatus: "approved", templateType: "notification", purpose: "notification", variables: [], enabled: true, version: 2 }; },
        importTemplate: async () => { calls += 1; return { id: templateId, signatureId, templateKey: "notice.valid", externalCode: "SMS_VALID", externalName: "Valid", externalStatus: "approved", templateType: "notification", purpose: "notification", variables: [], enabled: true, version: 2 }; },
      },
    });
    const requests = [
      new Request("https://app.test/api/admin/sms/resources/sync-commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, idempotencyKey: "sync:bad-id", syncId: "not-a-uuid", candidates: [{ id: candidateId, checksum: "checksum" }] }) }),
      new Request("https://app.test/api/admin/sms/resources/sync-commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, idempotencyKey: "sync:bad-candidate", syncId, candidates: [{ id: "not-a-uuid", checksum: "checksum" }] }) }),
      new Request("https://app.test/api/admin/sms/signatures/not-a-uuid", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, idempotencyKey: "signature:bad-id", enabled: false }) }),
      new Request("https://app.test/api/admin/sms/templates/not-a-uuid", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, idempotencyKey: "template:bad-id", enabled: false }) }),
      new Request("https://app.test/api/admin/sms/templates/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, idempotencyKey: "template:bad-candidate", candidateId: "not-a-uuid", checksum: "checksum", templateKey: "notice.valid", purpose: "notification", signatureExternalKey: "sign" }) }),
    ];

    for (const request of requests) expect((await handler(request)).status).toBe(400);
    expect(calls).toBe(0);
  });
});
