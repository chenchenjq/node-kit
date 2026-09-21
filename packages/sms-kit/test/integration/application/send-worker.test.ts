import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { SendWorker } from "../../../src/application/send-worker.js";
import { DispatchRecoveryService } from "../../../src/application/dispatch-recovery-service.js";
import { SendService } from "../../../src/application/send-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { SmsProvider } from "../../../src/ports/provider.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import type { SmsStore } from "../../../src/ports/store.js";
import { startPostgres } from "../postgres/helpers.js";
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

const tenantId = "worker-tenant" as TenantId;

class Clock {
  constructor(private value = new Date("2026-09-13T00:00:00.000Z")) {}
  now(): Date { return new Date(this.value); }
  advanceBy(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

class Provider {
  calls = { send: 0 };
  onSend?: () => void;
  private readonly results: Array<Awaited<ReturnType<SmsProvider["send"]>>> = [];
  queueResult(result: Awaited<ReturnType<SmsProvider["send"]>>): void { this.results.push(result); }
  readonly send: SmsProvider["send"] = async () => {
    this.calls.send += 1;
    this.onSend?.();
    return this.results.shift() ?? { kind: "accepted", bizId: "default-biz", requestId: "default-request" };
  };
}

describe("SendWorker", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;
  let clock: Clock;
  let provider: Provider;

  const protectors = {
    phoneProtector: {
      protect: async () => ({ ciphertext: "phone-ciphertext", keyId: "phone-k1", lookupHash: "phone-hash", last4: "0000", masked: "138****0000" }),
      unprotect: async () => "13800138000" as never,
    },
    payloadProtector: {
      seal: async () => ({ ciphertext: "payload-ciphertext", keyId: "payload-k1" }),
      open: async () => ({ orderNo: "A-100" }),
    },
  };

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool; stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "worker-sign", changeType: "new", checksum: "worker-signature", resourceType: "signature", snapshot: { kind: "signature", externalName: "Worker", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "worker-template", changeType: "new", checksum: "worker-template", resourceType: "template", signatureExternalKey: "worker-sign", templateKey: "order.worker", purpose: "notification", snapshot: { kind: "template", externalCode: "SMS_WORKER", externalName: "Worker", externalStatus: "approved", templateType: "notification", variableNames: ["orderNo"] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await commitResourceFixturePreview(store, preview);
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "id", accessKeySecretRef: "secret", receiptCallbackTokenRef: "token", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date(), expectedVersion: config.version });
    await store.policy.get();
  }, 120_000);

  afterAll(async () => stop?.());

  async function enqueue(key: string): Promise<string> {
    const service = new SendService({ store, provider: provider as never, ...protectors, clock, ids: { next: () => crypto.randomUUID(), messageId: () => crypto.randomUUID() as never }, events: { emit: () => undefined }, providerTimeoutMs: 1_000 });
    return (await service.enqueueNotification({ tenantId, templateKey: "order.worker", phone: "13800138000", variables: { orderNo: "A-100" }, purpose: "notification", idempotencyKey: key })).id;
  }

  function worker(currentStore: SmsStore = store): SendWorker {
    return new SendWorker({ store: currentStore, provider: provider as never, ...protectors, clock });
  }

  it("does not resend an acceptance-unknown message and creates one reconcile job", async () => {
    clock = new Clock(); provider = new Provider();
    const messageId = await enqueue("unknown");
    provider.queueResult({ kind: "unknown", code: "ACCEPTANCE_UNKNOWN" });
    await worker().runBatch({ workerId: "w1", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    await worker().runBatch({ workerId: "w2", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    const jobs = await pool.query<{ count: string }>("select count(*)::text as count from sms_kit.send_job where message_id = $1 and job_type = 'reconcile'", [messageId]);
    expect(provider.calls.send).toBe(1);
    const message = await store.messages.get({ tenantId, id: messageId as never });
    expect(message).toMatchObject({ acceptanceStatus: "unknown" });
    expect(message).not.toHaveProperty("renderParamsCiphertext");
    expect(jobs.rows[0]).toEqual({ count: "1" });
  });

  it("backs off explicit retryable rejections and sends no more than three attempts", async () => {
    clock = new Clock(); provider = new Provider();
    const messageId = await enqueue("retryable");
    provider.queueResult({ kind: "rejected", code: "THROTTLED", retryable: true });
    provider.queueResult({ kind: "rejected", code: "THROTTLED", retryable: true });
    provider.queueResult({ kind: "rejected", code: "THROTTLED", retryable: true });
    for (let i = 0; i < 3; i += 1) {
      await worker().runBatch({ workerId: `w-${i}`, limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
      clock.advanceBy(60_000);
    }
    expect(provider.calls.send).toBe(3);
    const message = await store.messages.get({ tenantId, id: messageId as never });
    expect(message).toMatchObject({ acceptanceStatus: "rejected" });
    expect(message).not.toHaveProperty("renderParamsCiphertext");
  });

  it("recovers a crash after the dispatch marker as unknown without provider resend", async () => {
    clock = new Clock(); provider = new Provider();
    const messageId = await enqueue("marker-crash");
    const crashingWorker = new SendWorker({
      store,
      provider: provider as never,
      phoneProtector: protectors.phoneProtector as never,
      payloadProtector: { ...protectors.payloadProtector, open: async () => { throw new Error("injected dispatch crash"); } } as never,
      clock,
    });
    await expect(crashingWorker.runBatch({ workerId: "w1", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 })).rejects.toThrow("injected dispatch crash");
    clock.advanceBy(31_000);
    await new DispatchRecoveryService({ store, clock }).runBatch({ limit: 10, abandonedBefore: clock.now() });
    await worker().runBatch({ workerId: "w2", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    expect(provider.calls.send).toBe(0);
    await expect(store.messages.get({ tenantId, id: messageId as never })).resolves.toMatchObject({ acceptanceStatus: "unknown" });
  });

  it("acquires later jobs after a slow provider call so every dispatch has a fresh lease", async () => {
    clock = new Clock(); provider = new Provider();
    const first = await enqueue("sequential-expiry-a");
    const second = await enqueue("sequential-expiry-b");
    provider.onSend = () => { if (provider.calls.send === 1) clock.advanceBy(31_000); };
    await expect(worker().runBatch({ workerId: "w1", limit: 2, leaseMs: 30_000, providerTimeoutMs: 1_000 })).resolves.toBe(2);
    expect(provider.calls.send).toBe(2);
    await expect(store.messages.get({ tenantId, id: first as never })).resolves.toMatchObject({ acceptanceStatus: "accepted" });
    await expect(store.messages.get({ tenantId, id: second as never })).resolves.toMatchObject({ acceptanceStatus: "accepted" });
  });

  it("finalizes a known retryable rejection and releases its budget when fenced reschedule fails", async () => {
    clock = new Clock(); provider = new Provider();
    const messageId = await enqueue("reschedule-fence");
    provider.queueResult({ kind: "rejected", code: "THROTTLED", retryable: true });
    const fencedJobs = new Proxy(store.jobs, {
      get(target, property) {
        if (property === "tryReschedule") return async () => false;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const fencedStore = new Proxy(store, {
      get(target, property) {
        if (property === "jobs") return fencedJobs;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as SmsStore;
    await worker(fencedStore).runBatch({ workerId: "w1", limit: 10, leaseMs: 30_000, providerTimeoutMs: 1_000 });
    const budget = await pool.query<{ state: string }>("select state from sms_kit.send_budget_reservation where message_id = $1", [messageId]);
    await expect(store.messages.get({ tenantId, id: messageId as never })).resolves.toMatchObject({ acceptanceStatus: "rejected" });
    expect(budget.rows).toEqual([{ state: "released" }]);
  });
});
