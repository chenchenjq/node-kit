import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { SendService } from "../../../src/application/send-service.js";
import { SendWorker } from "../../../src/application/send-worker.js";
import { ReconcileService } from "../../../src/application/reconcile-service.js";
import { ReceiptService } from "../../../src/application/receipt-service.js";
import { ResourceSyncService } from "../../../src/application/resource-sync-service.js";
import { MaintenanceService } from "../../../src/application/maintenance-service.js";
import { PolicyService } from "../../../src/application/policy-service.js";
import { HealthService } from "../../../src/application/health-service.js";
import { createAliyunProvider } from "../../../src/aliyun/index.js";
import { FakeAliyunApi } from "../../../src/testing/fake-aliyun-api.js";
import type { SmsProvider, ProviderSendResult } from "../../../src/ports/provider.js";
import type { TenantId } from "../../../src/core/types.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

const tenantId = "final-review" as TenantId;
const otherTenantId = "final-review-other" as TenantId;
const actor = { id: "reviewer", tenantId };
const callbackToken = Buffer.alloc(32, 7).toString("base64url");
const ids = { next: () => crypto.randomUUID(), messageId: () => crypto.randomUUID() as never };
const events = { emit: () => undefined };
const protectors = {
  phoneProtector: { protect: async () => ({ ciphertext: "encrypted-phone", keyId: "key", lookupHash: crypto.randomUUID(), last4: "8000", masked: "138****8000" }), unprotect: async () => "+8613800138000" as never },
  payloadProtector: { seal: async () => ({ ciphertext: "encrypted-sensitive-variables", keyId: "key" }), open: async () => ({ code: "123456" }) },
};

describe("final service and PostgreSQL regressions", () => {
  let pool: Pool; let store: PgSmsStore; let stop: () => Promise<void>;
  let now: Date; let result: ProviderSendResult; let sends: number; let outId: string;
  const clock = { now: () => new Date(now) };
  const provider = {
    send: async (input: any) => { sends++; outId = input.outId; return result; },
    queryDelivery: async () => ({ kind: "page", items: [{ outId, status: "delivered" }], hasNextPage: false }),
    listSignatures: async () => ({ items: [{ externalKey: "sign", externalName: "Test", externalStatus: "approved", externalType: "通用类型" }] }),
    listTemplates: async () => ({ items: ["notification", "verification"].map((type) => ({ externalKey: `aliyun:template:SMS_${type}`, externalCode: `SMS_${type}`, externalName: "Test", externalStatus: "approved", templateType: type, variableNames: ["code"] })) }),
  } as unknown as SmsProvider;
  function service(p: SmsProvider = provider) { return new SendService({ store, provider: p, ...protectors, clock, ids, events, providerTimeoutMs: 10 }); }
  function input(type: "notification" | "verification") { return { tenantId, templateKey: `test.${type}`, phone: "13800138000", variables: { code: "123456" }, purpose: type, idempotencyKey: crypto.randomUUID() }; }
  function sync(p: SmsProvider = provider) { return new ResourceSyncService({ store, provider: p, clock, ids, events, authorizer: { assert: () => undefined } }); }
  const runWorker = () => new SendWorker({ store, provider, ...protectors, clock }).runBatch({ workerId: "test", leaseMs: 30_000, providerTimeoutMs: 10, limit: 1 });

  beforeAll(async () => { const pg = await startPostgres(); pool = pg.pool; stop = pg.stop; await migrateSmsKit(pool); store = new PgSmsStore(pool); }, 120_000);
  afterAll(async () => stop?.());
  beforeEach(async () => {
    await pool.query("truncate sms_kit.signature, sms_kit.resource_sync, sms_kit.policy_config, sms_kit.daily_send_budget, sms_kit.provider_config, sms_kit.rate_limit_bucket cascade");
    now = new Date("2026-09-14T00:00:00Z"); sends = 0; result = { kind: "accepted", bizId: "biz", requestId: "req" };
    const resources = [createResourceSyncCandidate({ id: ids.next(), externalKey: "sign", checksum: "s", resourceType: "signature", changeType: "new", snapshot: { kind: "signature", externalName: "Test", externalStatus: "approved", externalType: "通用类型" } }),
      ...(["notification", "verification"] as const).map((type) => createResourceSyncCandidate({ id: ids.next(), externalKey: `aliyun:template:SMS_${type}`, checksum: type, changeType: "new", resourceType: "template", templateKey: `test.${type}`, purpose: type, signatureExternalKey: "sign", snapshot: { kind: "template", externalCode: `SMS_${type}`, externalName: "Test", externalStatus: "approved", templateType: type, variableNames: ["code"] } }))];
    const preview = await store.resources.createSyncPreview({ id: ids.next(), actorId: actor.id, expiresAt: new Date("2030-01-01"), resources });
    await commitResourceFixturePreview(store, preview, now);
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "id", accessKeySecretRef: "secret", receiptCallbackTokenRef: "callback", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ expectedVersion: config.version, status: "succeeded", summary: {}, testedAt: now });
    await store.policy.get();
  });

  it.each(["accepted", "unknown"] as const)("automatically reconciles a direct %s response without seeded jobs", async (kind) => {
    result = kind === "accepted" ? result : { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
    await service().sendOtpNow(input("verification")).catch((error) => { if (kind !== "unknown") throw error; });
    const jobs = await pool.query("select state from sms_kit.send_job where job_type = 'reconcile'");
    expect(jobs.rows).toEqual([{ state: "pending" }]);
    await new ReconcileService({ store, provider, phoneProtector: protectors.phoneProtector, clock, events }).runBatch({ limit: 10 });
    expect((await store.messages.list({ tenantId, page: 1, pageSize: 10 })).items[0]).toMatchObject({ acceptanceStatus: "accepted", deliveryStatus: "delivered" });
    expect(sends).toBe(1);
  });

  it("automatically reconciles an accepted queued send", async () => {
    const message = await service().enqueueNotification(input("notification")); await runWorker();
    expect((await pool.query("select state from sms_kit.send_job where message_id = $1 and job_type = 'reconcile'", [message.id])).rows).toEqual([{ state: "pending" }]);
    await new ReconcileService({ store, provider, phoneProtector: protectors.phoneProtector, clock, events }).runBatch({ limit: 10 });
    expect(await store.messages.get({ tenantId, id: message.id })).toMatchObject({ deliveryStatus: "delivered" });
  });

  it("retires an expired reconciliation lease after an idempotent terminal callback without crossing tenants", async () => {
    const message = await service().sendOtpNow(input("verification"));
    const [activeJob] = await store.jobs.leaseReconciliation({ owner: "racing-query", limit: 1, leaseMs: 1_000, now });
    if (activeJob?.leaseToken === undefined) throw new Error("reconciliation job was not leased");
    const body = JSON.stringify([{
      phone_number: "13800138000", biz_id: "biz", send_time: "2026-09-14 08:00:00", report_time: "2026-09-14 08:00:05",
      success: true, err_code: "DELIVERED", err_msg: "delivered", sms_size: "1", out_id: message.id,
    }]);
    const receipts = new ReceiptService({
      store, secrets: { resolve: async () => callbackToken }, clock, events, safetyMarginMs: 0,
    });

    await receipts.ingest({ token: callbackToken, body, deadlineAt: new Date(now.getTime() + 1_000) });
    await receipts.ingest({ token: callbackToken, body, deadlineAt: new Date(now.getTime() + 1_000) });
    const foreignJobId = crypto.randomUUID();
    await pool.query(`insert into sms_kit.send_job
      (id, tenant_id, dedupe_key, job_type, message_id, state, available_at, attempt_count, max_attempts, payload, created_at, updated_at)
      values ($1, $2, $3, 'reconcile', $4, 'pending', $5, 0, 1, '{"kind":"reconcile"}'::jsonb, now(), now())`,
    [foreignJobId, otherTenantId, `foreign-reconcile:${message.id}`, message.id, now]);

    now = new Date(now.getTime() + 6 * 60_000);
    let queries = 0;
    const terminalProvider = { ...provider, queryDelivery: async () => { queries += 1; throw new Error("terminal messages must not be queried"); } };
    await expect(new ReconcileService({ store, provider: terminalProvider, phoneProtector: protectors.phoneProtector, clock, events }).runBatch({ limit: 10 })).resolves.toBe(1);

    expect(queries).toBe(0);
    expect((await pool.query("select state from sms_kit.send_job where id = $1", [activeJob.id])).rows).toEqual([{ state: "succeeded" }]);
    expect((await pool.query("select state from sms_kit.send_job where id = $1", [foreignJobId])).rows).toEqual([{ state: "pending" }]);
    await expect(store.jobs.trySucceed({ tenantId, id: activeJob.id, leaseToken: activeJob.leaseToken })).resolves.toBe(false);
    await expect(new HealthService({ store, clock }).getSnapshot({ tenantId })).resolves.toMatchObject({ pendingJobs: 0 });
    expect((await pool.query("select count(*)::text as count from sms_kit.delivery_receipt where message_id = $1", [message.id])).rows).toEqual([{ count: "1" }]);
  });

  it("rolls back acceptance when durable reconciliation cannot be scheduled", async () => {
    const original = store.jobs.ensureReconcile;
    store.jobs.ensureReconcile = async () => { throw new Error("schedule failure"); };
    try { await expect(service().sendOtpNow(input("verification"))).rejects.toMatchObject({ code: "STORAGE_FAILURE" }); }
    finally { store.jobs.ensureReconcile = original; }
    expect((await pool.query("select status from sms_kit.send_attempt")).rows).toEqual([{ status: "started" }]);
    expect((await pool.query("select acceptance_status from sms_kit.send_message")).rows).toEqual([{ acceptance_status: "pending" }]);
  });

  it("releases an OTP retryable rejection because OTP will never retry", async () => {
    result = { kind: "rejected", code: "isv.BUSINESS_LIMIT_CONTROL", retryable: true };
    await expect(service().sendOtpNow(input("verification"))).rejects.toMatchObject({ code: "PROVIDER_THROTTLED" });
    expect((await pool.query("select state from sms_kit.send_budget_reservation")).rows).toEqual([{ state: "released" }]);
    expect((await pool.query("select held_count from sms_kit.daily_send_budget")).rows).toEqual([{ held_count: "0" }]);
  });

  it("times out an injected provider, persists unknown, and fences its late completion", async () => {
    let finish!: (value: ProviderSendResult) => void;
    const late = { ...provider, send: () => new Promise<ProviderSendResult>((resolve) => { finish = resolve; }) };
    await expect(service(late).sendOtpNow(input("verification"))).rejects.toMatchObject({ code: "ACCEPTANCE_UNKNOWN" });
    finish({ kind: "accepted", bizId: "late", requestId: "late" });
    await Promise.resolve();
    expect((await pool.query("select acceptance_status from sms_kit.send_message")).rows).toEqual([{ acceptance_status: "unknown" }]);
    expect((await pool.query("select state from sms_kit.send_job where job_type = 'reconcile'")).rows).toEqual([{ state: "pending" }]);
  });

  it.each(["template", "signature"])("ends queued work when its %s loses approval before dispatch", async (table) => {
    const message = await service().enqueueNotification(input("notification"));
    await pool.query(`update sms_kit.${table} set external_status = 'AUDIT_STATE_NOT_PASS'`);
    await runWorker();
    expect(sends).toBe(0);
    expect((await pool.query("select status from sms_kit.send_attempt")).rows).toHaveLength(0);
    expect((await pool.query("select state from sms_kit.send_job where message_id = $1", [message.id])).rows).toEqual([{ state: "dead" }]);
    expect(await store.messages.get({ tenantId, id: message.id })).toMatchObject({ acceptanceStatus: "rejected" });
  });

  it("scrubs render envelopes and atomically ends expired queued work at 90 days", async () => {
    const message = await service().enqueueNotification(input("notification"));
    now = new Date("2026-12-14T00:00:00Z");
    await new MaintenanceService({ store, clock }).applyRetention({ batchSize: 100 });
    expect((await pool.query("select render_params_ciphertext, render_params_key_id, phone_ciphertext, acceptance_status from sms_kit.send_message where id = $1", [message.id])).rows).toEqual([{ render_params_ciphertext: null, render_params_key_id: null, phone_ciphertext: null, acceptance_status: "rejected" }]);
    expect((await pool.query("select state from sms_kit.send_job where message_id = $1", [message.id])).rows).toEqual([{ state: "dead" }]);
    await runWorker(); expect(sends).toBe(0);
  });

  it("releases a recent held budget when retention terminates old undispatched work", async () => {
    const message = await service().enqueueNotification(input("notification"));
    now = new Date("2026-12-14T00:00:00Z");
    await store.transaction((tx) => store.policy.holdBudget({ tenantId, messageId: message.id, now }, tx));
    await pool.query("update sms_kit.send_budget_reservation set held_at = $2 where message_id = $1", [message.id, now]);
    await new MaintenanceService({ store, clock }).applyRetention({ batchSize: 100 });
    expect((await pool.query("select state from sms_kit.send_budget_reservation where message_id = $1", [message.id])).rows).toEqual([{ state: "released" }]);
    expect((await pool.query("select held_count from sms_kit.daily_send_budget where budget_date = '2026-12-14'")).rows).toEqual([{ held_count: "0" }]);
  });

  it("persists existing signature approval loss and disables dependent templates", async () => {
    const p = { ...provider, listSignatures: async () => ({ items: [{ externalKey: "sign", externalName: "Test", externalStatus: "AUDIT_STATE_NOT_PASS", externalType: "通用类型" }] }) };
    const preview = await sync(p).preview(actor);
    await sync(p).commit(actor, { syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]).toMatchObject({ externalStatus: "AUDIT_STATE_NOT_PASS", enabled: false });
    expect(await store.resources.findTemplateByKey({ templateKey: "test.notification" })).toMatchObject({ enabled: false });
  });

  it("refreshes existing unselected templates that lose cloud approval", async () => {
    const p = { ...provider, listTemplates: async () => ({ items: (await provider.listTemplates({ region: "cn", accessKeyId: "id", accessKeySecret: "secret", pageSize: 50 })).items.map((item) => ({ ...item, externalStatus: "AUDIT_STATE_NOT_PASS" })) }) };
    const preview = await sync(p).preview(actor);
    await sync(p).commit(actor, { syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    expect(await store.resources.findTemplateByKey({ templateKey: "test.notification" })).toMatchObject({ externalStatus: "AUDIT_STATE_NOT_PASS", enabled: false });
  });

  it("does not roll back signature revocation when its existing template also changes", async () => {
    const p = { ...provider,
      listSignatures: async () => ({ items: [{ externalKey: "sign", externalName: "Test", externalStatus: "AUDIT_STATE_NOT_PASS", externalType: "通用类型" }] }),
      listTemplates: async () => ({ items: (await provider.listTemplates({ region: "cn", accessKeyId: "id", accessKeySecret: "secret", pageSize: 50 })).items.map((item) => ({ ...item, externalName: "Changed" })) }),
    };
    const preview = await sync(p).preview(actor);
    await sync(p).commit(actor, { syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]).toMatchObject({ externalStatus: "AUDIT_STATE_NOT_PASS", enabled: false });
    expect(await store.resources.findTemplateByKey({ templateKey: "test.notification" })).toMatchObject({ enabled: false, externalName: "Changed" });
  });

  it("bounds a queued injected send and keeps one unknown attempt after its late response", async () => {
    let finish!: (value: ProviderSendResult) => void;
    const message = await service().enqueueNotification(input("notification"));
    const late = { ...provider, send: () => { sends++; return new Promise<ProviderSendResult>((resolve) => { finish = resolve; }); } };
    await new SendWorker({ store, provider: late, ...protectors, clock }).runBatch({ workerId: "late", leaseMs: 30_000, providerTimeoutMs: 10, limit: 1 });
    finish({ kind: "accepted", bizId: "late", requestId: "late" });
    await runWorker();
    expect(sends).toBe(1);
    expect(await store.messages.get({ tenantId, id: message.id })).toMatchObject({ acceptanceStatus: "unknown" });
    expect((await pool.query("select status from sms_kit.send_attempt")).rows).toEqual([{ status: "unknown" }]);
    expect((await pool.query("select state from sms_kit.send_job where job_type = 'reconcile'")).rows).toEqual([{ state: "pending" }]);
  });

  it("production provider cannot retire resources from an incomplete snapshot", async () => {
    const api = new FakeAliyunApi(); api.querySmsSignList = async () => ({ code: "OK", totalCount: 1, smsSignList: [] });
    const p = createAliyunProvider({ api, secretResolver: { resolve: async () => "test-only" } });
    const before = (await pool.query("select count(*) from sms_kit.resource_sync")).rows;
    await expect(sync(p).preview(actor)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect((await pool.query("select count(*) from sms_kit.resource_sync")).rows).toEqual(before);
    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]).toMatchObject({ enabled: true, externalStatus: "approved" });
  });

  it("matches PostgreSQL policy integer and interval boundaries through the service", async () => {
    const policy = await store.policy.get();
    const s = new PolicyService({ store, clock, ids, authorizer: { assert: () => undefined } });
    for (const patch of [{ phoneMinIntervalSeconds: 0 }, { phoneMinIntervalSeconds: 3601 }, { ipWindowSeconds: 59 }]) {
      await expect(s.update(actor, { ...policy, expectedVersion: policy.version, ...patch })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    await expect(s.update(actor, { ...policy, expectedVersion: policy.version, phoneMinIntervalSeconds: 1, ipWindowSeconds: 60, phoneHourlyLimit: 2147483647, phoneDailyLimit: 2147483647, ipWindowLimit: 2147483647, systemDailyBudget: 2147483647 })).resolves.toMatchObject({ version: 2 });
  });

  it("health uses the injected budget day and does not mistake query receipts for fresh callbacks", async () => {
    const message = await service().sendOtpNow(input("verification"));
    now = new Date("2026-09-14T02:00:00Z");
    await store.receipts.record({ tenantId, messageId: message.id, providerBizId: "biz", dedupeKey: "health-query", deliveryStatus: "delivered", occurredAt: now, receivedAt: now, source: "query" });
    const policy = await store.policy.get();
    await new PolicyService({ store, clock, ids, authorizer: { assert: () => undefined } }).update(actor, { ...policy, expectedVersion: policy.version, systemDailyBudget: 1 });
    const health = await new HealthService({ store, clock }).getSnapshot({ tenantId });
    expect(health.systemBudgetRemaining).toBe(0);
    expect(health.status).toBe("degraded");
    expect(health.warnings).toContain("DELIVERY_UNKNOWN");
    expect(health.lastReceiptAt).toBeUndefined();
  });
});
