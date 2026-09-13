import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { MaintenanceService } from "../../../src/application/maintenance-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

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
    await store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
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
    const maintenance = new MaintenanceService({ store, clock: { now: () => new Date("2026-10-20T00:00:00.000Z") } });
    await maintenance.applyRetention({ batchSize: 100 });

    await expect(pool.query<{ phone_ciphertext: string | null; phone_key_id: string | null }>("select phone_ciphertext, phone_key_id from sms_kit.send_message where id = $1", [messageId])).resolves.toMatchObject({ rows: [{ phone_ciphertext: null, phone_key_id: null }] });
  });
});
