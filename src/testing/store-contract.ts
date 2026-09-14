import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SmsKitError } from "../core/errors.js";
import type { MessageId, TenantId, TemplateId } from "../core/types.js";
import { createResourceSyncCandidate, type SmsStore } from "../ports/store.js";
import { createSafeMessageFixture, FakeClock, SequenceIdGenerator } from "./fakes.js";

export type SmsStoreContractFactory = Readonly<{
  name?: string;
  tenantMode?: "multiple" | "fixed";
  createStore(): Promise<SmsStore>;
  clock: FakeClock;
  ids: SequenceIdGenerator;
  templateId(): TemplateId;
  tenantId(value: string): TenantId;
  messageId(): MessageId;
  createVerifiedProof(input: Readonly<{
    tenantId: TenantId;
    subjectId: string;
    action: string;
    proof: string;
    now: Date;
  }>): Promise<unknown>;
}>;

function messageInput(factory: SmsStoreContractFactory, tenantId: TenantId, key: string) {
  return createSafeMessageFixture({
    id: factory.messageId(), tenantId, templateId: factory.templateId(), idempotencyKey: key,
    submittedAt: factory.clock.now(),
  });
}

/**
 * Shared behavioral contract for a complete trusted-tenant SmsStore. Factories
 * provide only setup seams that no public Store port can express (a template
 * and an already verified proof).
 */
export function runSmsStoreContract(factory: SmsStoreContractFactory): void {
  describe(factory.name === undefined ? "SmsStore contract" : `SmsStore contract (${factory.name})`, () => {
    it("fences singleton configuration and policy updates independently", async () => {
      const store = await factory.createStore();
      const config = await store.config.get();
      const policy = await store.policy.get();
      const bootstrap = {
        provider: "aliyun", region: `cn-contract-${factory.ids.next()}`,
        accessKeyIdRef: "secret://id", accessKeySecretRef: "secret://key", receiptCallbackTokenRef: "secret://callback",
        enabled: false,
      } as const;
      expect(config.version).toBe(0);
      await expect(store.config.update({ ...bootstrap, expectedVersion: 1 }))
        .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
      const configured = await store.config.update({ ...bootstrap, expectedVersion: config.version });
      const updatedPolicy = await store.policy.update({ ...policy, expectedVersion: policy.version, otpMaxAttempts: policy.otpMaxAttempts === 10 ? 9 : policy.otpMaxAttempts + 1 });
      expect(configured.version).toBe(config.version + 1);
      expect(updatedPolicy.version).toBe(policy.version + 1);
      await expect(store.config.update({
        provider: "aliyun", region: "cn-stale", accessKeyIdRef: "secret://id", accessKeySecretRef: "secret://key",
        receiptCallbackTokenRef: "secret://callback", enabled: false, expectedVersion: config.version,
      })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    });

    it("rejects expired resource preview checksums", async () => {
      const store = await factory.createStore();
      const candidate = createResourceSyncCandidate({
        id: randomUUID(), externalKey: `sign:${factory.ids.next()}`, changeType: "new", checksum: "expected",
        resourceType: "signature", snapshot: { kind: "signature", externalName: "Contract", externalStatus: "approved", externalType: "text" },
      });
      const preview = await store.resources.createSyncPreview({
        id: randomUUID(), actorId: "contract", expiresAt: new Date("2020-01-01T00:00:00.000Z"), resources: [candidate],
      });
      await expect(store.resources.commitSync({ syncId: preview.id, candidates: [{ id: candidate.id, checksum: candidate.checksum }] }))
        .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    });

    it("keeps message idempotency scoped to the resolved tenant", async () => {
      const store = await factory.createStore();
      const tenantA = factory.tenantId(`tenant-a-${factory.ids.next()}`);
      const tenantB = factory.tenantId(`tenant-b-${factory.ids.next()}`);
      const key = `message:${factory.ids.next()}`;
      const first = await store.messages.createWithSendJob(messageInput(factory, tenantA, key));
      const replay = await store.messages.createWithSendJob({ ...messageInput(factory, tenantA, key), id: factory.messageId() });
      const otherTenant = await store.messages.createWithSendJob(messageInput(factory, tenantB, key));

      expect(replay).toMatchObject({ created: false, message: { id: first.message.id } });
      expect(tenantB === tenantA).toBe(factory.tenantMode === "fixed");
      if (factory.tenantMode === "fixed") {
        expect(otherTenant).toMatchObject({ created: false, message: { id: first.message.id } });
        await expect(store.messages.get({ tenantId: tenantB, id: first.message.id }))
          .resolves.toMatchObject({ id: first.message.id });
      } else {
        expect(otherTenant.message.id).not.toBe(first.message.id);
        expect(await store.messages.get({ tenantId: tenantB, id: first.message.id })).toBeUndefined();
      }
      expect(await store.messages.list({ tenantId: tenantB, page: 1, pageSize: 10 })).toMatchObject({ total: 1 });
    });

    it("fences stale leases and requires matching direct or queued attempt inputs", async () => {
      const store = await factory.createStore();
      const tenant = factory.tenantId(`tenant-lease-${factory.ids.next()}`);
      const input = { ...messageInput(factory, tenant, `message:${factory.ids.next()}`), sendJob: {
        id: randomUUID(), dedupeKey: `send:${factory.ids.next()}`, availableAt: factory.clock.now(), maxAttempts: 3,
      } };
      const { message } = await store.messages.createWithSendJob(input);
      const [firstLease] = await store.jobs.lease({ tenantId: tenant, owner: "worker-a", leaseMs: 60_000, limit: 1, now: factory.clock.now() });
      if (firstLease?.leaseToken === undefined) throw new Error("expected a lease");
      const rescheduled = await store.jobs.reschedule({ tenantId: tenant, id: firstLease.id, leaseToken: firstLease.leaseToken, availableAt: factory.clock.now() });
      const [secondLease] = await store.jobs.lease({ tenantId: tenant, owner: "worker-b", leaseMs: 60_000, limit: 1, now: factory.clock.now() });
      if (secondLease?.leaseToken === undefined) throw new Error("expected a renewed lease");
      expect(rescheduled.leaseToken).toBeUndefined();
      await expect(store.jobs.succeed({ tenantId: tenant, id: firstLease.id, leaseToken: firstLease.leaseToken }))
        .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
      await expect(store.attempts.createStarted({ tenantId: tenant, messageId: message.id, dispatchMode: "queued", dispatchMarkedAt: factory.clock.now() }))
        .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
      await expect(store.attempts.createStarted({ tenantId: tenant, messageId: message.id, dispatchMode: "queued", leaseToken: secondLease.leaseToken, dispatchMarkedAt: factory.clock.now() }))
        .resolves.toMatchObject({ dispatchMode: "queued", leaseToken: secondLease.leaseToken });
    });

    it("atomically holds one system budget reservation", async () => {
      const store = await factory.createStore();
      const tenant = factory.tenantId(`tenant-budget-${factory.ids.next()}`);
      const policy = await store.policy.get();
      await store.policy.update({ ...policy, expectedVersion: policy.version, systemDailyBudget: 1 });
      const first = (await store.messages.createWithSendJob(messageInput(factory, tenant, `message:${factory.ids.next()}`))).message;
      const second = (await store.messages.createWithSendJob(messageInput(factory, tenant, `message:${factory.ids.next()}`))).message;
      const results = await Promise.allSettled([
        store.transaction((tx) => store.policy.holdBudget({ tenantId: tenant, messageId: first.id, now: factory.clock.now() }, tx)),
        store.transaction((tx) => store.policy.holdBudget({ tenantId: tenant, messageId: second.id, now: factory.clock.now() }, tx)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const held = results.find((result) => result.status === "fulfilled");
      if (held === undefined || held.status !== "fulfilled") throw new Error("expected one reservation");
      expect(await store.transaction((tx) => store.policy.releaseBudget({ tenantId: tenant, messageId: held.value.messageId }, tx))).toBe(true);
    });

    it("allows only one concurrent proof consumer and returns same-key replays", async () => {
      const store = await factory.createStore();
      const tenant = factory.tenantId(`tenant-proof-${factory.ids.next()}`);
      const proof = `proof:${factory.ids.next()}`;
      const binding = { tenantId: tenant, subjectId: "user-1", action: "password.change", proof, now: factory.clock.now() };
      await factory.createVerifiedProof(binding);
      const results = await Promise.all([
        store.transaction((tx) => store.challenges.consumeProof({ ...binding, consumptionKey: "operation-a", now: () => binding.now }, tx)),
        store.transaction((tx) => store.challenges.consumeProof({ ...binding, consumptionKey: "operation-b", now: () => binding.now }, tx)),
      ]);
      expect(results.filter((result) => result.consumed)).toHaveLength(1);

      const replayProof = `proof:${factory.ids.next()}`;
      await factory.createVerifiedProof({ ...binding, proof: replayProof });
      const replay = await Promise.all([
        store.transaction((tx) => store.challenges.consumeProof({ ...binding, proof: replayProof, consumptionKey: "operation-replay", now: () => binding.now }, tx)),
        store.transaction((tx) => store.challenges.consumeProof({ ...binding, proof: replayProof, consumptionKey: "operation-replay", now: () => binding.now }, tx)),
      ]);
      expect(replay.every((result) => result.consumed)).toBe(true);
      expect(replay.map((result) => result.consumed ? result.replay : false).sort()).toEqual([false, true]);
    });

    it("rejects a proof bound to another subject without consuming it", async () => {
      const store = await factory.createStore();
      const tenant = factory.tenantId(`tenant-binding-${factory.ids.next()}`);
      const proof = `proof:${factory.ids.next()}`;
      const now = factory.clock.now();
      await factory.createVerifiedProof({ tenantId: tenant, subjectId: "user-1", action: "password.change", proof, now });

      await expect(store.transaction((tx) => store.challenges.consumeProof({ tenantId: tenant, subjectId: "other-user", action: "password.change", proof, consumptionKey: "wrong", now: () => now }, tx)))
        .rejects.toMatchObject({ code: "PROOF_INVALID" });
      await expect(store.transaction((tx) => store.challenges.consumeProof({ tenantId: tenant, subjectId: "user-1", action: "password.change", proof, consumptionKey: "right", now: () => now }, tx)))
        .resolves.toEqual({ consumed: true, replay: false });
    });

    it("increments one rate-limit bucket atomically", async () => {
      const store = await factory.createStore();
      const tenant = factory.tenantId(`tenant-rate-${factory.ids.next()}`);
      const now = factory.clock.now();
      const values = await Promise.all(Array.from({ length: 8 }, () => store.rateLimits.increment({
        tenantId: tenant, scope: "phone_purpose", scopeHash: "hash:scope", windowStart: now, windowSeconds: 60,
        expiresAt: new Date(now.getTime() + 60_000),
      })));
      expect(values.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("keeps audit events tenant-scoped", async () => {
      const store = await factory.createStore();
      const tenantA = factory.tenantId(`tenant-audit-a-${factory.ids.next()}`);
      const tenantB = factory.tenantId(`tenant-audit-b-${factory.ids.next()}`);
      const event = await store.audits.append({
        id: randomUUID(), tenantId: tenantA, actorId: "admin", action: "message.read", targetType: "message", result: "succeeded",
        metadata: {
          redactedFields: ["phone", "not-allowed"],
          counts: [{ name: "message", value: 1 }, { name: "not-allowed", value: 1 }, { name: "receipt", value: Number.POSITIVE_INFINITY }],
          phone: "+8613800138000",
        } as never,
        occurredAt: factory.clock.now(),
      });
      expect(event.metadata).toEqual({ redactedFields: ["phone"], counts: [{ name: "message", value: 1 }] });
      expect((await store.audits.list({ tenantId: tenantA, page: 1, pageSize: 10 })).items[0]?.metadata)
        .toEqual({ redactedFields: ["phone"], counts: [{ name: "message", value: 1 }] });
      const tenantBEvents = await store.audits.list({ tenantId: tenantB, page: 1, pageSize: 10 });
      if (factory.tenantMode === "fixed") {
        expect(tenantBEvents).toMatchObject({ items: [{ id: event.id }], total: 1 });
      } else {
        expect(tenantBEvents).toEqual({ items: [], total: 0 });
      }
    });

    it("recomputes dirty statistics without double counting acceptance or delivery", async () => {
      const store = await factory.createStore();
      const tenant = factory.tenantId(`tenant-stats-${factory.ids.next()}`);
      const input = messageInput(factory, tenant, `message:${factory.ids.next()}`);
      const { message } = await store.messages.createWithSendJob(input);
      const attempt = await store.attempts.createStarted({ tenantId: tenant, messageId: message.id, dispatchMode: "direct", dispatchMarkedAt: factory.clock.now() });
      await store.attempts.completeByDispatchToken({ tenantId: tenant, dispatchToken: attempt.dispatchToken, status: "accepted", occurredAt: factory.clock.now() });
      await store.messages.completeAcceptance({ tenantId: tenant, dispatchToken: attempt.dispatchToken, status: "accepted", evidence: "same-dispatch-response", providerBizId: `biz:${factory.ids.next()}`, occurredAt: factory.clock.now() });
      await store.messages.completeDelivery({ tenantId: tenant, id: message.id, status: "delivered", occurredAt: factory.clock.now() });
      const receipt = { tenantId: tenant, messageId: message.id, dedupeKey: `receipt:${factory.ids.next()}`, providerBizId: `biz:${factory.ids.next()}`, deliveryStatus: "delivered" as const, occurredAt: factory.clock.now(), receivedAt: factory.clock.now(), source: "callback" as const };
      expect((await store.receipts.record(receipt)).created).toBe(true);
      expect((await store.receipts.record(receipt)).created).toBe(false);

      const unmatched = {
        tenantId: factory.tenantId(`tenant-unmatched-a-${factory.ids.next()}`), dedupeKey: `receipt:${factory.ids.next()}`,
        providerBizId: `unmatched:${factory.ids.next()}`, deliveryStatus: "failed" as const,
        occurredAt: factory.clock.now(), receivedAt: factory.clock.now(), source: "callback" as const,
      };
      const recordedUnmatched = await store.receipts.record(unmatched);
      expect(recordedUnmatched).toMatchObject({ created: true, receipt: { matchStatus: "unmatched" } });
      expect(recordedUnmatched.receipt.tenantId).toBeUndefined();
      expect(recordedUnmatched.receipt.messageId).toBeUndefined();
      const duplicateUnmatched = await store.receipts.record({ ...unmatched, tenantId: factory.tenantId(`tenant-unmatched-b-${factory.ids.next()}`) });
      expect(duplicateUnmatched).toMatchObject({ created: false, receipt: { matchStatus: "unmatched" } });
      expect(duplicateUnmatched.receipt.tenantId).toBeUndefined();
      expect(duplicateUnmatched.receipt.messageId).toBeUndefined();

      expect(await store.stats.rollupDirtyDates({ tenantId: tenant, limit: 10 })).toBeGreaterThan(0);
      expect(await store.stats.rollupDirtyDates({ tenantId: tenant, limit: 10 })).toBe(0);
      const stats = await store.stats.query({ tenantId: tenant, from: new Date("2026-09-13T00:00:00.000Z"), to: new Date("2026-09-14T00:00:00.000Z") });
      expect(stats).toContainEqual(expect.objectContaining({ submittedCount: 1, acceptedCount: 1, acceptanceRejectedCount: 0, acceptanceUnknownCount: 0, deliveryWaitingCount: 0, deliveredCount: 1, deliveryFailedCount: 0, deliveryUnknownFinalCount: 0, retryCount: 0 }));
    });
  });
}
