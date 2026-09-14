import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { MaintenanceService } from "../../../src/application/maintenance-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

const tenantId = "maintenance-tenant" as TenantId;
const yesterday = new Date("2026-09-13T10:00:00.000Z");

describe("MaintenanceService", () => {
  let pool: Pool;
  let stop: (() => Promise<void>) | undefined;
  let store: PgSmsStore;
  let templateId: string;

  beforeAll(async () => {
    const postgres = await startPostgres(); pool = postgres.pool; stop = postgres.stop;
    await migrateSmsKit(pool); store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "maintenance-sign", changeType: "new", checksum: "maintenance-sign", resourceType: "signature", snapshot: { kind: "signature", externalName: "Maintenance", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "maintenance-template", changeType: "new", checksum: "maintenance-template", resourceType: "template", signatureExternalKey: "maintenance-sign", templateKey: "maintenance.delivery", purpose: "notification", snapshot: { kind: "template", externalCode: "SMS_MAINTENANCE", externalName: "Maintenance", externalStatus: "approved", templateType: "notification", variableNames: [] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await commitResourceFixturePreview(store, preview);
    templateId = (await store.resources.findTemplateByKey({ templateKey: "maintenance.delivery" }))!.id;
  }, 120_000);
  afterAll(async () => stop?.());

  async function acceptedMessage(): Promise<string> {
    const created = await store.messages.createWithSendJob({
      id: crypto.randomUUID() as never, tenantId, idempotencyKey: crypto.randomUUID(), templateId: templateId as never,
      templateKeySnapshot: "maintenance.delivery", externalTemplateCodeSnapshot: "SMS_MAINTENANCE", signatureNameSnapshot: "Maintenance",
      purpose: "notification", phoneCiphertext: "phone-ciphertext", phoneKeyId: "phone-k1", phoneHash: "hash", phoneLast4: "0000", phoneMasked: "138****0000", variableNames: [], submittedAt: yesterday,
    });
    const attempt = await store.attempts.createStarted({ tenantId, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: yesterday });
    await store.messages.completeAcceptance({ tenantId, dispatchToken: attempt.dispatchToken, status: "accepted", evidence: "same-dispatch-response", providerBizId: `biz-${created.message.id}`, occurredAt: yesterday });
    return created.message.id;
  }

  it("repairs yesterday's absolute statistic after a late receipt", async () => {
    const messageId = await acceptedMessage();
    const maintenance = new MaintenanceService({ store, clock: { now: () => new Date("2026-09-14T00:00:00.000Z") } });
    await maintenance.rollupDirtyDates({ limit: 10 });
    await store.messages.completeDelivery({ tenantId, id: messageId as never, status: "delivered", occurredAt: yesterday });
    await maintenance.rollupDirtyDates({ limit: 10 });

    await expect(store.stats.query({ tenantId, from: new Date("2026-09-13T00:00:00.000Z"), to: new Date("2026-09-14T00:00:00.000Z") })).resolves.toEqual([
      expect.objectContaining({ acceptedCount: 1, deliveredCount: 1 }),
    ]);
  });

  it("removes sensitive payloads at their approved lifecycle boundaries", async () => {
    const messageId = await acceptedMessage();
    const maintenance = new MaintenanceService({ store, clock: { now: () => new Date("2027-01-20T00:00:00.000Z") } });
    await maintenance.applyRetention({ batchSize: 100 });

    await expect(pool.query<{ phone_ciphertext: string | null; phone_key_id: string | null }>("select phone_ciphertext, phone_key_id from sms_kit.send_message where id = $1", [messageId])).resolves.toMatchObject({ rows: [{ phone_ciphertext: null, phone_key_id: null }] });
  });

  it("uses distinct lifecycle cutoffs without deleting anonymous statistics or budget enforcement", async () => {
    const oldPhone = await acceptedMessage();
    const retainedPhone = await acceptedMessage();
    const now = new Date("2026-12-31T00:00:00.000Z");
    await pool.query("update sms_kit.send_message set submitted_at = $1 where id = $2", [new Date("2026-10-01T00:00:00.000Z"), oldPhone]);
    await pool.query("update sms_kit.send_message set submitted_at = $1 where id = $2", [new Date("2026-10-03T00:00:00.000Z"), retainedPhone]);
    await pool.query(`insert into sms_kit.otp_challenge (id, tenant_id, subject_id, action, purpose, phone_hash, code_hash, max_attempts, expires_at, created_at)
      values ($1,$2,'subject','action','step_up','phone','code',3,$3,$3), ($4,$2,'subject','action','step_up','phone','code',3,$5,$5)`, [crypto.randomUUID(), tenantId, new Date("2026-12-23T00:00:00.000Z"), crypto.randomUUID(), new Date("2026-12-25T00:00:00.000Z")]);
    const auditId = crypto.randomUUID();
    await pool.query(`insert into sms_kit.audit_event (id, tenant_id, actor_id, action, target_type, result, metadata, occurred_at)
      values ($1,$2,'actor','sensitive.action','message','succeeded','{"redactedFields":["phone"]}'::jsonb,$3)`, [auditId, tenantId, new Date("2026-06-01T00:00:00.000Z")]);
    await pool.query(`insert into sms_kit.delivery_receipt (id, tenant_id, message_id, match_status, dedupe_key, provider_biz_id, delivery_status, occurred_at, received_at, source, redacted_payload)
      values ($1,$2,$3,'matched',$4,'retention-biz','delivered',$5,$5,'query','{"redactedFields":["phone"]}'::jsonb)`, [crypto.randomUUID(), tenantId, oldPhone, `retention-${crypto.randomUUID()}`, new Date("2026-06-01T00:00:00.000Z")]);
    await pool.query(`insert into sms_kit.rate_limit_bucket (tenant_id, scope, scope_hash, window_start, window_seconds, count, expires_at)
      values ($1,'global','expired', $2, 60, 1, $2)`, [tenantId, new Date("2026-12-01T00:00:00.000Z")]);
    await pool.query(`insert into sms_kit.daily_stat (tenant_id, stat_date, template_key, purpose, submitted_count, accepted_count, acceptance_rejected_count, acceptance_unknown_count, delivery_waiting_count, delivered_count, delivery_failed_count, delivery_unknown_final_count, retry_count, updated_at)
      values ($1,'2026-06-01','anonymous','notification',1,1,0,0,0,1,0,0,0,now()) on conflict do nothing`, [tenantId]);
    const maintenance = new MaintenanceService({ store, clock: { now: () => now } });

    await maintenance.applyRetention({ batchSize: 100 });

    await expect(pool.query("select id from sms_kit.otp_challenge where tenant_id = $1", [tenantId])).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query<{ phone_ciphertext: string | null }>("select phone_ciphertext from sms_kit.send_message where id = $1", [oldPhone])).resolves.toMatchObject({ rows: [{ phone_ciphertext: null }] });
    await expect(pool.query<{ phone_ciphertext: string | null }>("select phone_ciphertext from sms_kit.send_message where id = $1", [retainedPhone])).resolves.toMatchObject({ rows: [{ phone_ciphertext: "phone-ciphertext" }] });
    await expect(pool.query("select id from sms_kit.audit_event where id = $1", [auditId])).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query<{ redacted_payload: unknown }>("select redacted_payload from sms_kit.delivery_receipt where provider_biz_id = 'retention-biz'")).resolves.toMatchObject({ rows: [{ redacted_payload: null }] });
    await expect(pool.query("select * from sms_kit.rate_limit_bucket where scope_hash = 'expired'")).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query("select * from sms_kit.daily_stat where tenant_id = $1 and template_key = 'anonymous'", [tenantId])).resolves.toMatchObject({ rowCount: 1 });
  });

  it("collects only a deterministic 90-day batch of ineligible reservations", async () => {
    const firstMessage = await acceptedMessage();
    const secondMessage = await acceptedMessage();
    const now = new Date("2026-12-31T00:00:00.000Z");
    const heldAt = new Date("2026-09-30T00:00:00.000Z");
    await pool.query("insert into sms_kit.daily_send_budget (budget_date, held_count, updated_at) values ('2026-09-30', 2, now()) on conflict (budget_date) do update set held_count = 2", []);
    await pool.query(`insert into sms_kit.send_budget_reservation (id, message_id, budget_date, state, held_at)
      values ($1,$2,'2026-09-30','held',$3), ($4,$5,'2026-09-30','held',$6)`, [crypto.randomUUID(), firstMessage, heldAt, crypto.randomUUID(), secondMessage, new Date("2026-09-30T00:00:01.000Z")]);
    const maintenance = new MaintenanceService({ store, clock: { now: () => now } });

    await maintenance.applyRetention({ batchSize: 1 });

    await expect(pool.query<{ message_id: string }>("select message_id from sms_kit.send_budget_reservation where message_id = any($1::uuid[]) order by held_at", [[firstMessage, secondMessage]])).resolves.toMatchObject({ rows: [{ message_id: secondMessage }] });
  });
});
