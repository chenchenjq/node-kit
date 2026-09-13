import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { DispatchRecoveryService } from "../../../src/application/dispatch-recovery-service.js";
import { SendWorker } from "../../../src/application/send-worker.js";
import { SendService } from "../../../src/application/send-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { SmsProvider } from "../../../src/ports/provider.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantId = "recovery-tenant" as TenantId;

class Clock {
  constructor(private value = new Date("2026-09-14T00:00:00.000Z")) {}
  now(): Date { return new Date(this.value); }
  advanceBy(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

class DeferredProvider {
  calls = { send: 0 };
  private resolve?: (value: Awaited<ReturnType<SmsProvider["send"]>>) => void;
  private reject?: (reason?: unknown) => void;
  private called?: () => void;
  private readonly calledPromise = new Promise<void>((resolve) => { this.called = resolve; });
  defer = false;
  readonly send: SmsProvider["send"] = async () => {
    this.calls.send += 1; this.called?.();
    if (!this.defer) return { kind: "accepted", bizId: "biz", requestId: "request" };
    return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  };
  waitUntilSendCalled(): Promise<void> { return this.calledPromise; }
  resolveNext(result: Awaited<ReturnType<SmsProvider["send"]>>): void { this.resolve?.(result); }
  rejectNext(reason: unknown): void { this.defer = false; this.reject?.(reason); }
}

describe("DispatchRecoveryService", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;
  let clock: Clock;
  let provider: DeferredProvider;
  const protectors = {
    phoneProtector: { protect: async () => ({ ciphertext: "phone", keyId: "phone-k1", lookupHash: "hash", last4: "0000", masked: "138****0000" }), unprotect: async () => "13800138000" as never },
    payloadProtector: { seal: async () => ({ ciphertext: "params", keyId: "params-k1" }), open: async () => ({ orderNo: "A-200" }) },
  };

  beforeAll(async () => {
    const postgres = await startPostgres(); pool = postgres.pool; stop = postgres.stop;
    await migrateSmsKit(pool); store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "recovery-sign", changeType: "new", checksum: "recovery-signature", resourceType: "signature", snapshot: { kind: "signature", externalName: "Recovery", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "recovery-template", changeType: "new", checksum: "recovery-template", resourceType: "template", signatureExternalKey: "recovery-sign", templateKey: "order.recovery", purpose: "notification", snapshot: { kind: "template", externalCode: "SMS_RECOVERY", externalName: "Recovery", externalStatus: "approved", templateType: "notification", variableNames: ["orderNo"] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "id", accessKeySecretRef: "secret", receiptCallbackTokenRef: "token", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date(), expectedVersion: config.version });
    await store.policy.get();
  }, 120_000);
  afterAll(async () => stop?.());

  async function enqueue(key: string): Promise<string> {
    const service = new SendService({ store, provider: provider as never, ...protectors, clock, ids: { next: () => crypto.randomUUID(), messageId: () => crypto.randomUUID() as never }, events: { emit: () => undefined }, providerTimeoutMs: 1_000 });
    return (await service.enqueueNotification({ tenantId, templateKey: "order.recovery", phone: "13800138000", variables: { orderNo: "A-200" }, purpose: "notification", idempotencyKey: key })).id;
  }
  const worker = () => new SendWorker({ store, provider: provider as never, ...protectors, clock });
  const recovery = () => new DispatchRecoveryService({ store, clock });

  it("does not resend when an outstanding provider call outlives its lease and accepts its late same-token response", async () => {
    clock = new Clock(); provider = new DeferredProvider(); provider.defer = true;
    const messageId = await enqueue("late-response");
    const original = worker().runBatch({ workerId: "w1", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    await provider.waitUntilSendCalled();
    clock.advanceBy(31_000);
    await recovery().runBatch({ limit: 10, abandonedBefore: clock.now() });
    await worker().runBatch({ workerId: "w2", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    provider.resolveNext({ kind: "accepted", bizId: "late-biz", requestId: "late-request" });
    await original;
    expect(provider.calls.send).toBe(1);
    const message = await store.messages.get({ tenantId, id: messageId as never });
    expect(message).toMatchObject({ acceptanceStatus: "accepted", providerBizId: "late-biz" });
    expect(message).not.toHaveProperty("renderParamsCiphertext");
  });

  it("treats a late throw after recovery marked the same token unknown as idempotent", async () => {
    clock = new Clock(); provider = new DeferredProvider(); provider.defer = true;
    const messageId = await enqueue("late-throw");
    const original = worker().runBatch({ workerId: "w1", limit: 2, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    await provider.waitUntilSendCalled();
    const nextMessageId = await enqueue("late-throw-next");
    clock.advanceBy(31_000);
    await recovery().runBatch({ limit: 10, abandonedBefore: clock.now() });
    provider.rejectNext(new Error("late transport failure"));
    await expect(original).resolves.toBe(2);
    await expect(store.messages.get({ tenantId, id: messageId as never })).resolves.toMatchObject({ acceptanceStatus: "unknown" });
    await expect(store.messages.get({ tenantId, id: nextMessageId as never })).resolves.toMatchObject({ acceptanceStatus: "accepted" });
    expect(provider.calls.send).toBe(2);
  });

  it("keeps a late same-token explicit rejection terminal and releases its held budget after recovery", async () => {
    clock = new Clock(); provider = new DeferredProvider(); provider.defer = true;
    const messageId = await enqueue("late-rejection");
    const original = worker().runBatch({ workerId: "w1", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    await provider.waitUntilSendCalled();
    clock.advanceBy(31_000);
    await recovery().runBatch({ limit: 10, abandonedBefore: clock.now() });
    provider.resolveNext({ kind: "rejected", code: "MOBILE_INVALID", retryable: true, requestId: "late-reject" });
    await expect(original).resolves.toBe(1);
    const budget = await pool.query<{ state: string }>("select state from sms_kit.send_budget_reservation where message_id = $1", [messageId]);
    await expect(store.messages.get({ tenantId, id: messageId as never })).resolves.toMatchObject({ acceptanceStatus: "rejected", finalErrorCode: "MOBILE_INVALID" });
    expect(budget.rows).toEqual([{ state: "released" }]);
    expect(provider.calls.send).toBe(1);
  });

  it("locks an expired job before the fresh marker recheck so a blocked marker cannot be orphaned", async () => {
    clock = new Clock(); provider = new DeferredProvider();
    const messageId = await enqueue("locked-marker-recheck");
    const [leased] = await store.jobs.lease({ tenantId, owner: "w1", jobType: "send", limit: 1, leaseMs: 30_000, now: clock.now() });
    if (leased?.leaseToken === undefined) throw new Error("send job was not leased");
    clock.advanceBy(31_000);
    let marker: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    await store.transaction(async (tx) => {
      const [locked] = await store.jobs.lockExpiredSendJobs({ before: clock.now(), limit: 1 }, tx);
      expect(locked?.id).toBe(leased.id);
      marker = store.transaction((workerTx) => store.attempts.createStarted({
        tenantId, messageId: messageId as never, dispatchMode: "queued", leaseToken: leased.leaseToken!, dispatchMarkedAt: clock.now(), minimumLeaseUntil: new Date(clock.now().getTime() + 1_000),
      }, workerTx)).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await expect(store.jobs.returnToPendingIfNoStarted({ tenantId, id: leased.id, leaseToken: leased.leaseToken! }, tx)).resolves.toBe(true);
    });
    await expect(marker).resolves.toMatchObject({ ok: false, error: { code: "CONCURRENT_MODIFICATION" } });
    await expect(store.jobs.get({ tenantId, id: leased.id })).resolves.toMatchObject({ state: "pending" });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from sms_kit.send_attempt where message_id = $1", [messageId])).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});
