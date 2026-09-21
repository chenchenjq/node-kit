import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SmsKitError } from "../../../src/core/errors.js";
import type { TenantId } from "../../../src/core/types.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "./helpers.js";
import { commitResourceFixturePreview } from "./resource-fixtures.js";

describe("PostgreSQL configuration and resources", () => {
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    await migrateSmsKit(postgres.pool);
    store = new PgSmsStore(postgres.pool);
  }, 120_000);

  afterAll(async () => stop?.());

  it("keeps configuration and policy optimistic versions independent", async () => {
    await expect(store.config.get()).resolves.toEqual({
      provider: "aliyun", status: "unconfigured", enabled: false, lastTestStatus: "never", version: 0,
    });
    const policy = await store.policy.get();
    const configured = await store.config.update({
      provider: "aliyun",
      region: "cn-shanghai",
      endpoint: "https://dysmsapi.aliyuncs.com",
      accessKeyIdRef: "secret://id-v2",
      accessKeySecretRef: "secret://key-v2",
      receiptCallbackTokenRef: "secret://callback-v2",
      enabled: true,
      expectedVersion: 0,
    });
    const updatedPolicy = await store.policy.update({ ...policy, expectedVersion: policy.version, otpMaxAttempts: 4 });

    expect(configured.version).toBe(1);
    expect(updatedPolicy.version).toBe(2);
    await expect(store.config.update({
      provider: "aliyun", region: "cn-beijing", accessKeyIdRef: "secret://id", accessKeySecretRef: "secret://key",
      receiptCallbackTokenRef: "secret://callback", enabled: true, expectedVersion: 0,
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
  });

  it("projects test summaries before JSON persistence", async () => {
    const config = await store.config.get();
    const result = await store.config.recordConnectionTest({
      status: "succeeded", testedAt: new Date("2026-09-13T00:00:00.000Z"), expectedVersion: config.version,
      summary: { redactedFields: ["secret", "bad"], counts: [{ name: "resource", value: 2 }, { name: "receipt", value: Number.NaN }], nested: { key: "value" } } as never,
    });
    if (result.status === "unconfigured") throw new Error("configuration was not initialized");
    expect(result.lastTestSummary).toEqual({ redactedFields: ["secret"], counts: [{ name: "resource", value: 2 }] });
  });

  it("claims and replays admin operations only inside the trusted tenant namespace", async () => {
    const tenantA = "tenant-admin-a" as TenantId;
    const tenantB = "tenant-admin-b" as TenantId;
    const operation = "signature.update";
    const idempotencyKey = "signature:disable:1";
    const resultSnapshot = { kind: "signature", id: "signature-1", version: 2 };

    await store.transaction(async (tx) => {
      await expect(store.adminOperations.claim({
        tenantId: tenantA, operation, idempotencyKey, requestChecksum: "request-a",
      }, tx)).resolves.toEqual({ kind: "claimed" });
      await store.adminOperations.complete({
        tenantId: tenantA, operation, idempotencyKey, requestChecksum: "request-a", resultSnapshot,
      }, tx);
    });

    await store.transaction(async (tx) => {
      await expect(store.adminOperations.claim({
        tenantId: tenantA, operation, idempotencyKey, requestChecksum: "request-a",
      }, tx)).resolves.toEqual({ kind: "replay", resultSnapshot });
    });
    await expect(store.transaction((tx) => store.adminOperations.claim({
      tenantId: tenantA, operation, idempotencyKey, requestChecksum: "different-request",
    }, tx))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<SmsKitError>);

    await store.transaction(async (tx) => {
      await expect(store.adminOperations.claim({
        tenantId: tenantB, operation, idempotencyKey, requestChecksum: "request-b",
      }, tx)).resolves.toEqual({ kind: "claimed" });
      await store.adminOperations.complete({
        tenantId: tenantB, operation, idempotencyKey, requestChecksum: "request-b",
        resultSnapshot: { ...resultSnapshot, version: 3 },
      }, tx);
    });
  });

  it("rejects an expired resource preview and does not persist arbitrary snapshot data", async () => {
    const id = randomUUID();
    const preview = await store.resources.createSyncPreview({
      id,
      actorId: "operator-1",
      expiresAt: new Date("2020-01-01T00:00:00.000Z"),
      resources: [createResourceSyncCandidate({
        id: randomUUID(), externalKey: "sign:one", changeType: "new", checksum: "signature-checksum",
        resourceType: "signature", snapshot: {
          kind: "signature", externalName: "Production", externalStatus: "approved", externalType: "text",
        },
      })],
    });

    await expect(store.resources.commitSync({
      syncId: preview.id,
      candidates: [{ id: preview.candidates[0]!.id, checksum: "signature-checksum" }],
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it("rejects a checksum conflict without importing a partial preview", async () => {
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: "operator-2", expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [createResourceSyncCandidate({
        id: randomUUID(), externalKey: "sign:two", changeType: "new", checksum: "expected",
        resourceType: "signature", snapshot: {
          kind: "signature", externalName: "Secondary", externalStatus: "approved", externalType: "text",
        },
      })],
    });

    await expect(store.resources.commitSync({
      syncId: preview.id,
      candidates: [{ id: preview.candidates[0]!.id, checksum: "different" }],
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it("imports a template explicitly through its signature identity and preserves local controls on refresh", async () => {
    const signature = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "signature:template-owner", changeType: "new", checksum: "signature-template",
      resourceType: "signature", snapshot: { kind: "signature", externalName: "Template owner", externalStatus: "approved", externalType: "text" },
    });
    const template = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "provider-template:42", changeType: "new", checksum: "template-v1",
      resourceType: "template", signatureExternalKey: "signature:template-owner", templateKey: "notice.stable", purpose: "shipping",
      snapshot: { kind: "template", externalCode: "SMS_42", externalName: "Shipping", externalStatus: "approved", templateType: "notification", variableNames: ["order"] },
    });
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: "operator-3", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [template, signature],
    });
    await commitResourceFixturePreview(store, preview);
    const first = await store.resources.findTemplateByKey({ templateKey: "notice.stable" });
    expect(first?.signatureId).toBeDefined();
    expect(first?.purpose).toBe("shipping");
    const refreshedPreview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: "operator-5", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [createResourceSyncCandidate({
        id: randomUUID(), externalKey: "provider-template:42", changeType: "changed", checksum: "template-v3",
        resourceType: "template", signatureExternalKey: "signature:template-owner", templateKey: "notice.stable", purpose: "shipping",
        snapshot: { kind: "template", externalCode: "SMS_42", externalName: "Shipping refreshed", externalStatus: "approved", templateType: "notification", variableNames: ["order"] },
      })],
    });
    await store.resources.commitSync({ syncId: refreshedPreview.id, candidates: refreshedPreview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });
    const refreshed = await store.resources.findTemplateByKey({ templateKey: "notice.stable" });
    expect(refreshed?.purpose).toBe("shipping");
    expect(refreshed?.externalName).toBe("Shipping refreshed");
  });
});
