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
  private called?: () => void;
  private readonly calledPromise = new Promise<void>((resolve) => { this.called = resolve; });
  defer = false;
  readonly send: SmsProvider["send"] = async () => {
    this.calls.send += 1; this.called?.();
    if (!this.defer) return { kind: "accepted", bizId: "biz", requestId: "request" };
    return new Promise((resolve) => { this.resolve = resolve; });
  };
  waitUntilSendCalled(): Promise<void> { return this.calledPromise; }
  resolveNext(result: Awaited<ReturnType<SmsProvider["send"]>>): void { this.resolve?.(result); }
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
});
