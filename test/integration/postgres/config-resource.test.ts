import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SmsKitError } from "../../../src/core/errors.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "./helpers.js";

describe("PostgreSQL configuration and resources", () => {
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    await migrateSmsKit(postgres.pool);
    store = new PgSmsStore(postgres.pool);
    await postgres.pool.query(`
      insert into sms_kit.provider_config (
        id, provider, region, access_key_id_ref, access_key_secret_ref,
        receipt_callback_token_ref, status, enabled, last_test_status, created_at, updated_at
      ) values (1, 'aliyun', 'cn-hangzhou', 'secret://id', 'secret://key',
        'secret://callback', 'untested', false, 'never', now(), now())`);
  }, 120_000);

  afterAll(async () => stop?.());

  it("keeps configuration and policy optimistic versions independent", async () => {
    const policy = await store.policy.get();
    const configured = await store.config.update({
      provider: "aliyun",
      region: "cn-shanghai",
      endpoint: "https://dysmsapi.aliyuncs.com",
      accessKeyIdRef: "secret://id-v2",
      accessKeySecretRef: "secret://key-v2",
      receiptCallbackTokenRef: "secret://callback-v2",
      enabled: true,
      expectedVersion: 1,
    });
    const updatedPolicy = await store.policy.update({ ...policy, expectedVersion: policy.version, otpMaxAttempts: 4 });

    expect(configured.version).toBe(2);
    expect(updatedPolicy.version).toBe(2);
    await expect(store.config.update({
      provider: "aliyun", region: "cn-beijing", accessKeyIdRef: "secret://id", accessKeySecretRef: "secret://key",
      receiptCallbackTokenRef: "secret://callback", enabled: true, expectedVersion: 1,
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
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

  it("imports a template through its signature identity and preserves local template controls on refresh", async () => {
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
    await store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });
    const first = await store.resources.findTemplateByKey({ templateKey: "notice.stable" });
    expect(first?.signatureId).toBeDefined();
    expect(first?.purpose).toBe("shipping");
    const refreshedPreview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: "operator-5", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [createResourceSyncCandidate({
        id: randomUUID(), externalKey: "provider-template:42", changeType: "changed", checksum: "template-v3",
        resourceType: "template", signatureExternalKey: "signature:template-owner", templateKey: "illegal.change", purpose: "illegal-change",
        snapshot: { kind: "template", externalCode: "SMS_42", externalName: "Shipping refreshed", externalStatus: "approved", templateType: "notification", variableNames: ["order"] },
      })],
    });
    await store.resources.commitSync({ syncId: refreshedPreview.id, candidates: refreshedPreview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });
    const refreshed = await store.resources.findTemplateByKey({ templateKey: "notice.stable" });
    expect(refreshed?.purpose).toBe("shipping");
    expect((await store.resources.findTemplateByKey({ templateKey: "illegal.change" }))).toBeUndefined();
  });
});
