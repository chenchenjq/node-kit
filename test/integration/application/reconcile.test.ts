import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ReconcileService } from "../../../src/application/reconcile-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { SmsProvider } from "../../../src/ports/provider.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantId = "reconcile-tenant" as TenantId;

class Clock {
  constructor(private value = new Date("2026-09-14T00:00:00.000Z")) {}
  now(): Date { return new Date(this.value); }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

class PagedProvider implements SmsProvider {
  readonly calls: Parameters<SmsProvider["queryDelivery"]>[0][] = [];
  private pages: Awaited<ReturnType<SmsProvider["queryDelivery"]>>[] = [];
  withPages(pages: Awaited<ReturnType<SmsProvider["queryDelivery"]>>[]): this { this.pages = pages; return this; }
  async queryDelivery(input: Parameters<SmsProvider["queryDelivery"]>[0]): Promise<Awaited<ReturnType<SmsProvider["queryDelivery"]>>> {
    this.calls.push(input);
    return this.pages[this.calls.length - 1] ?? { kind: "page", items: [], hasNextPage: false };
  }
  async testConnection(): Promise<never> { throw new Error("not used"); }
  async listSignatures(): Promise<never> { throw new Error("not used"); }
  async listTemplates(): Promise<never> { throw new Error("not used"); }
  async send(): Promise<never> { throw new Error("reconciliation never resends"); }
  parseReceipt(): never { throw new Error("not used"); }
}

describe("ReconcileService", () => {
  let pool: Pool;
  let stop: (() => Promise<void>) | undefined;
  let store: PgSmsStore;
  let templateId: string;
  const clock = new Clock();

  beforeAll(async () => {
    const postgres = await startPostgres(); pool = postgres.pool; stop = postgres.stop;
    await migrateSmsKit(pool); store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "reconcile-sign", changeType: "new", checksum: "reconcile-sign", resourceType: "signature", snapshot: { kind: "signature", externalName: "Reconcile", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "reconcile-template", changeType: "new", checksum: "reconcile-template", resourceType: "template", signatureExternalKey: "reconcile-sign", templateKey: "reconcile.delivery", purpose: "notification", snapshot: { kind: "template", externalCode: "SMS_RECONCILE", externalName: "Reconcile", externalStatus: "approved", templateType: "notification", variableNames: [] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    templateId = (await store.resources.findTemplateByKey({ templateKey: "reconcile.delivery" }))!.id;
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "id", accessKeySecretRef: "secret", receiptCallbackTokenRef: "callback", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: clock.now(), expectedVersion: config.version });
  }, 120_000);
  afterAll(async () => stop?.());

  async function seedUnknown(providerBizId?: string): Promise<string> {
    const created = await store.messages.createWithSendJob({
      id: crypto.randomUUID() as never, tenantId, idempotencyKey: crypto.randomUUID(), templateId: templateId as never,
      templateKeySnapshot: "reconcile.delivery", externalTemplateCodeSnapshot: "SMS_RECONCILE", signatureNameSnapshot: "Reconcile",
      purpose: "notification", phoneCiphertext: "ciphertext", phoneKeyId: "phone-k1", phoneHash: "phone-hash", phoneLast4: "0000", phoneMasked: "138****0000", variableNames: [], submittedAt: clock.now(),
    });
    const attempt = await store.attempts.createStarted({ tenantId, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: clock.now() });
    await store.messages.completeAcceptance({ tenantId, dispatchToken: attempt.dispatchToken, status: "unknown", evidence: "same-dispatch-response", ...(providerBizId === undefined ? {} : { providerBizId }), finalErrorCode: "ACCEPTANCE_UNKNOWN", occurredAt: clock.now() });
    await store.jobs.ensureReconcile({ tenantId, messageId: created.message.id, availableAt: clock.now() });
    return created.message.id;
  }

  async function clearPendingReconciliation(): Promise<void> {
    await pool.query("update sms_kit.send_job set state = 'succeeded', lease_owner = null, lease_token = null, lease_until = null where tenant_id = $1 and job_type = 'reconcile' and state in ('pending', 'leased')", [tenantId]);
  }

  it("queries every delivery page with required Alibaba fields without resending", async () => {
    await seedUnknown();
    const provider = new PagedProvider().withPages([{ kind: "page", items: [], hasNextPage: true }, { kind: "page", items: [], hasNextPage: false }]);
    const reconcile = new ReconcileService({ store, provider, phoneProtector: { unprotect: async () => "13800138000" as never }, clock, events: { emit: () => undefined } });

    await reconcile.runBatch({ limit: 10 });

    expect(provider.calls.map(({ region: _region, accessKeyId: _id, accessKeySecret: _secret, ...query }) => query)).toEqual([
      { phoneNumber: "13800138000", sendDate: "20260914", currentPage: 1, pageSize: 50 },
      { phoneNumber: "13800138000", sendDate: "20260914", currentPage: 2, pageSize: 50 },
    ]);
  });

  it("does not lease a reconciliation job whose message is no longer waiting and uncertain", async () => {
    const created = await store.messages.createWithSendJob({
      id: crypto.randomUUID() as never, tenantId, idempotencyKey: crypto.randomUUID(), templateId: templateId as never,
      templateKeySnapshot: "reconcile.delivery", externalTemplateCodeSnapshot: "SMS_RECONCILE", signatureNameSnapshot: "Reconcile",
      purpose: "notification", phoneCiphertext: "ciphertext", phoneKeyId: "phone-k1", phoneHash: "phone-hash", phoneLast4: "0000", phoneMasked: "138****0000", variableNames: [], submittedAt: clock.now(),
    });
    const attempt = await store.attempts.createStarted({ tenantId, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: clock.now() });
    await store.messages.completeAcceptance({ tenantId, dispatchToken: attempt.dispatchToken, status: "rejected", evidence: "same-dispatch-response", finalErrorCode: "REJECTED", occurredAt: clock.now() });
    const jobId = crypto.randomUUID();
    await pool.query(`insert into sms_kit.send_job (id, tenant_id, dedupe_key, job_type, message_id, state, available_at, attempt_count, max_attempts, payload, created_at, updated_at)
      values ($1, $2, $3, 'reconcile', $4, 'pending', $5, 0, 1, '{"kind":"reconcile"}'::jsonb, now(), now())`, [jobId, tenantId, `invalid-reconcile:${jobId}`, created.message.id, clock.now()]);
    const provider = new PagedProvider();
    const reconcile = new ReconcileService({ store, provider, phoneProtector: { unprotect: async () => "13800138000" as never }, clock, events: { emit: () => undefined } });

    await reconcile.runBatch({ limit: 10 });

    await expect(store.jobs.get({ tenantId, id: jobId })).resolves.toMatchObject({ state: "pending" });
    expect(provider.calls).toHaveLength(0);
  });

  it("uses only a matching OutId from every provider page and atomically promotes unknown acceptance", async () => {
    await clearPendingReconciliation();
    const targetId = await seedUnknown("target-biz");
    const otherId = await seedUnknown("other-biz");
    await pool.query("update sms_kit.send_job set available_at = $1 where tenant_id = $2 and message_id = $3 and job_type = 'reconcile'", [new Date(clock.now().getTime() - 1), tenantId, targetId]);
    const provider = new PagedProvider().withPages([{
      kind: "page", hasNextPage: true, items: [
        { outId: otherId, status: "delivered", occurredAt: clock.now() },
        { outId: targetId, status: "waiting" },
      ],
    }, {
      kind: "page", hasNextPage: false, items: [
        { outId: targetId, status: "delivered", occurredAt: clock.now() },
      ],
    }] as never);
    const reconcile = new ReconcileService({ store, provider, phoneProtector: { unprotect: async () => "13800138000" as never }, clock, events: { emit: () => undefined } });

    await reconcile.runBatch({ limit: 1 });

    await expect(store.messages.get({ tenantId, id: targetId as never })).resolves.toMatchObject({ acceptanceStatus: "accepted", deliveryStatus: "delivered", providerBizId: "target-biz" });
    await expect(store.messages.get({ tenantId, id: otherId as never })).resolves.toMatchObject({ acceptanceStatus: "unknown", deliveryStatus: "waiting" });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from sms_kit.delivery_receipt where message_id = $1 and tenant_id = $2", [targetId, tenantId])).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await store.stats.rollupDirtyDates({ tenantId, limit: 10 });
    const [stats] = await store.stats.query({ tenantId, from: new Date("2026-09-14T00:00:00.000Z"), to: new Date("2026-09-15T00:00:00.000Z") });
    expect(stats).toBeDefined();
    expect(stats!.acceptedCount).toBeLessThanOrEqual(stats!.submittedCount);
    expect(stats!.deliveredCount).toBeLessThanOrEqual(stats!.acceptedCount);
    expect(stats!.deliveryWaitingCount + stats!.deliveredCount + stats!.deliveryFailedCount + stats!.deliveryUnknownFinalCount).toBeLessThanOrEqual(stats!.submittedCount);
  });

  it("reclaims an expired reconciliation lease and fences its former token", async () => {
    await clearPendingReconciliation();
    const targetId = await seedUnknown("reclaim-biz");
    const [first] = await store.jobs.leaseReconciliation({ owner: "crashed-worker", limit: 1, leaseMs: 1_000, now: clock.now() });
    if (first?.leaseToken === undefined) throw new Error("reconciliation job was not leased");
    clock.advance(1_001);
    const provider = new PagedProvider().withPages([{ kind: "page", hasNextPage: false, items: [{ outId: targetId, status: "delivered", occurredAt: clock.now() }] }] as never);
    const reconcile = new ReconcileService({ store, provider, phoneProtector: { unprotect: async () => "13800138000" as never }, clock, events: { emit: () => undefined } });

    await reconcile.runBatch({ limit: 1 });

    await expect(store.messages.get({ tenantId, id: targetId as never })).resolves.toMatchObject({ deliveryStatus: "delivered" });
    await expect(store.jobs.trySucceed({ tenantId, id: first.id, leaseToken: first.leaseToken })).resolves.toBe(false);
  });

  it("persists a query receipt correlated by OutId when no BizId survived acceptance", async () => {
    await clearPendingReconciliation();
    const targetId = await seedUnknown();
    const provider = new PagedProvider().withPages([{ kind: "page", hasNextPage: false, items: [{ outId: targetId, status: "delivered", occurredAt: clock.now() }] }]);
    const reconcile = new ReconcileService({ store, provider, phoneProtector: { unprotect: async () => "13800138000" as never }, clock, events: { emit: () => undefined } });

    await reconcile.runBatch({ limit: 1 });

    await expect(pool.query<{ provider_biz_id: string | null; provider_out_id: string | null; source: string }>("select provider_biz_id, provider_out_id, source from sms_kit.delivery_receipt where message_id = $1 order by received_at desc limit 1", [targetId])).resolves.toMatchObject({ rows: [{ provider_biz_id: null, provider_out_id: targetId, source: "query" }] });
  });
});
