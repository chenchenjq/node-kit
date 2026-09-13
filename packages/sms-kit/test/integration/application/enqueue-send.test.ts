import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { SendService } from "../../../src/application/send-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;

describe("queued notification enqueue", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool; stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "sign-queued", changeType: "new", checksum: "queued-signature", resourceType: "signature", snapshot: { kind: "signature", externalName: "Queued", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "template-queued", changeType: "new", checksum: "queued-template", resourceType: "template", signatureExternalKey: "sign-queued", templateKey: "order.shipped", purpose: "notification", snapshot: { kind: "template", externalCode: "SMS_QUEUED", externalName: "Queued", externalStatus: "approved", templateType: "notification", variableNames: ["orderNo"] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
  }, 120_000);

  afterAll(async () => stop?.());

  it("durably creates one encrypted job per tenant idempotency key", async () => {
    const service = new SendService({
      store,
      provider: { send: async () => { throw new Error("queued messages must not dispatch inline"); } } as never,
      phoneProtector: { protect: async () => ({ ciphertext: "phone-ciphertext", keyId: "phone-k1", lookupHash: "phone-hash", last4: "0000", masked: "138****0000" }) } as never,
      payloadProtector: { seal: async () => ({ ciphertext: "payload-ciphertext", keyId: "payload-k1" }) } as never,
      clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID(), messageId: () => crypto.randomUUID() as never }, events: { emit: () => undefined }, providerTimeoutMs: 1_000,
    });
    const input = { tenantId: tenantA, templateKey: "order.shipped", phone: "13800138000", variables: { orderNo: "A-100" }, purpose: "notification", idempotencyKey: "order:A-100:shipped" };

    const first = await service.enqueueNotification(input);
    const duplicate = await service.enqueueNotification(input);
    const otherTenant = await service.enqueueNotification({ ...input, tenantId: tenantB });
    const persisted = await pool.query<{ render_params_ciphertext: string; render_params_key_id: string }>("select render_params_ciphertext, render_params_key_id from sms_kit.send_message where id = $1", [first.id]);
    const jobs = await pool.query<{ count: string }>("select count(*)::text as count from sms_kit.send_job where tenant_id = $1 and job_type = 'send'", [tenantA]);
    const plaintext = await pool.query<{ count: string }>("select count(*)::text as count from sms_kit.send_message where phone_ciphertext like '%13800138000%' or render_params_ciphertext like '%A-100%'");

    expect(duplicate.id).toBe(first.id);
    expect(otherTenant.id).not.toBe(first.id);
    expect(persisted.rows[0]).toEqual({ render_params_ciphertext: "payload-ciphertext", render_params_key_id: "payload-k1" });
    expect(jobs.rows[0]).toEqual({ count: "1" });
    expect(plaintext.rows[0]).toEqual({ count: "0" });
  });
});
