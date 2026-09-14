import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSmsAdminHandler } from "../../../src/next/index.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";

const admin = { id: "admin-1", tenantId: "tenant-a" as AuthorizationActor["tenantId"], permissions: ["resource.sync", "config.read", "signature.manage", "template.manage"] } as const;
const candidate = { id: "candidate-1", resourceType: "signature" as const, externalKey: "aliyun:sign:notice", changeType: "new" as const, checksum: "checksum-1", snapshot: { kind: "signature" as const, externalName: "Notice", externalStatus: "approved", externalType: "normal" } };

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
      body: JSON.stringify({ version: 1, idempotencyKey: "sync:1", syncId: "sync-1", candidates: [{ id: "candidate-1", checksum: "checksum-1" }] }),
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

  it("maps resource mutations by id and reports an immutable used template key as a safe conflict", async () => {
    const handler = handlerFor({
      resources: {
        updateSignature: async (_actor: unknown, input: { id: string; enabled: boolean; version: number }) => ({ id: input.id, externalKey: "aliyun:sign:notice", externalName: "Notice", externalStatus: "approved", externalType: "normal", enabled: input.enabled, version: input.version + 1 }),
        updateTemplate: async () => { throw new SmsKitError("CONCURRENT_MODIFICATION", "stable key is used by a sent message"); },
      },
    });
    const signature = await handler(new Request("https://app.test/api/admin/sms/signatures/signature-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 2, idempotencyKey: "signature:disable", enabled: false }),
    }));
    const rename = await handler(new Request("https://app.test/api/admin/sms/templates/template-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 3, idempotencyKey: "template:rename", templateKey: "notice.renamed" }),
    }));
    const renameBody = await rename.json();

    expect(signature.status).toBe(200);
    expect(await signature.json()).toMatchObject({ data: { id: "signature-1", enabled: false, version: 3 } });
    expect(rename.status).toBe(409);
    expect(renameBody).toMatchObject({ error: { code: "CONCURRENT_MODIFICATION", message: "concurrent modification" } });
    expect(JSON.stringify(renameBody)).not.toContain("sent message");
  });
});
