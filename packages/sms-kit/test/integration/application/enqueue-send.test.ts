import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { SendService } from "../../../src/application/send-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { startPostgres } from "../postgres/helpers.js";
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

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
    const otpTemplate = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "template-otp", changeType: "new", checksum: "otp-template", resourceType: "template", signatureExternalKey: "sign-queued", templateKey: "otp.login", purpose: "verification", snapshot: { kind: "template", externalCode: "SMS_OTP", externalName: "OTP", externalStatus: "approved", templateType: "verification", variableNames: ["code"] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template, otpTemplate] });
    await commitResourceFixturePreview(store, preview);
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date("2026-09-13T00:00:00.000Z"), expectedVersion: config.version });
    await store.policy.get();
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

  it("accepts a same-token late authoritative response after recovery marked it unknown", async () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const template = await store.resources.findTemplateByKey({ templateKey: "order.shipped" });
    if (template === undefined) throw new Error("seed template missing");
    const created = await store.messages.createWithSendJob({
      id: crypto.randomUUID() as never, tenantId: tenantA, idempotencyKey: "late-response", templateId: template.id,
      templateKeySnapshot: template.templateKey, externalTemplateCodeSnapshot: template.externalCode, signatureNameSnapshot: "Queued",
      purpose: "notification", phoneCiphertext: "phone", phoneKeyId: "phone-k1", phoneHash: "hash", phoneLast4: "0000", phoneMasked: "138****0000",
      variableNames: ["orderNo"], submittedAt: now,
    });
    const attempt = await store.attempts.createStarted({ tenantId: tenantA, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: now });
    await store.transaction(async (tx) => {
      await store.messages.completeAcceptance({ tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "unknown", evidence: "same-dispatch-response", finalErrorCode: "ACCEPTANCE_UNKNOWN", occurredAt: now }, tx);
      await store.attempts.completeByDispatchToken({ tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "unknown", errorCode: "ACCEPTANCE_UNKNOWN", occurredAt: now }, tx);
    });
    const accepted = await store.transaction(async (tx) => {
      const message = await store.messages.completeAcceptance({ tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "accepted", evidence: "positive-provider-evidence", providerBizId: "biz-late", occurredAt: now }, tx);
      await store.attempts.completeByDispatchToken({ tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "accepted", providerRequestId: "req-late", occurredAt: now }, tx);
      return message;
    });
    expect(accepted).toMatchObject({ acceptanceStatus: "accepted", providerBizId: "biz-late" });
  });

  it("serializes cross-midnight concurrent OTP cooldowns before either provider dispatch", async () => {
    let sends = 0;
    const makeService = (now: Date) => new SendService({
      store, provider: { send: async () => { sends += 1; return { kind: "accepted" as const, bizId: `biz-${sends}`, requestId: `req-${sends}` }; } } as never,
      phoneProtector: { protect: async () => ({ ciphertext: "phone", keyId: "phone-k1", lookupHash: "lock-phone", last4: "0000", masked: "138****0000" }) } as never,
      payloadProtector: { seal: async () => ({ ciphertext: "params", keyId: "params-k1" }) } as never,
      clock: { now: () => now }, ids: { next: () => crypto.randomUUID(), messageId: () => crypto.randomUUID() as never }, events: { emit: () => undefined }, providerTimeoutMs: 1_000,
    });
    const base = { tenantId: tenantA, templateKey: "otp.login", phone: "13800138000", variables: { code: "123456" }, purpose: "verification" };
    const results = await Promise.allSettled([
      makeService(new Date("2026-09-13T23:59:59.999Z")).sendOtpNow({ ...base, idempotencyKey: "cross-midnight-a" }),
      makeService(new Date("2026-09-14T00:00:00.001Z")).sendOtpNow({ ...base, idempotencyKey: "cross-midnight-b" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "RATE_LIMITED")).toHaveLength(1);
    expect(sends).toBe(1);
  });

  it("releases the held budget when a same-token recovered unknown is authoritatively rejected", async () => {
    const now = new Date("2026-09-15T00:00:00.000Z");
    const service = new SendService({
      store, provider: { send: async () => ({ kind: "unknown" as const, code: "ACCEPTANCE_UNKNOWN" as const }) } as never,
      phoneProtector: { protect: async () => ({ ciphertext: "phone", keyId: "phone-k1", lookupHash: "reject-phone", last4: "0000", masked: "138****0000" }) } as never,
      payloadProtector: { seal: async () => ({ ciphertext: "params", keyId: "params-k1" }) } as never,
      clock: { now: () => now }, ids: { next: () => crypto.randomUUID(), messageId: () => crypto.randomUUID() as never }, events: { emit: () => undefined }, providerTimeoutMs: 1_000,
    });
    await expect(service.sendOtpNow({ tenantId: tenantB, templateKey: "otp.login", phone: "13900139000", variables: { code: "654321" }, purpose: "verification", idempotencyKey: "recovered-reject" })).rejects.toMatchObject({ code: "ACCEPTANCE_UNKNOWN" });
    const message = (await store.messages.list({ tenantId: tenantB, page: 1, pageSize: 10 })).items[0]!;
    const [attempt] = await store.attempts.listExpiredStarted({ tenantId: tenantB, before: new Date(now.getTime() + 1), limit: 10 });
    // Recovery retains the dispatch token; authoritative same-dispatch evidence may resolve it once.
    const token = attempt?.dispatchToken ?? (await pool.query<{ dispatch_token: string }>("select dispatch_token from sms_kit.send_attempt where message_id = $1", [message.id])).rows[0]!.dispatch_token;
    await store.transaction(async (tx) => {
      await store.messages.completeAcceptance({ tenantId: tenantB, dispatchToken: token, status: "rejected", evidence: "same-dispatch-response", finalErrorCode: "isv.MOBILE_NUMBER_ILLEGAL", occurredAt: now }, tx);
      await store.attempts.completeByDispatchToken({ tenantId: tenantB, dispatchToken: token, status: "rejected", providerCode: "isv.MOBILE_NUMBER_ILLEGAL", occurredAt: now }, tx);
      await store.policy.releaseBudget({ tenantId: tenantB, messageId: message.id }, tx);
    });
    await expect(pool.query("select state from sms_kit.send_budget_reservation where message_id = $1", [message.id])).resolves.toMatchObject({ rows: [{ state: "released" }] });
    await expect(store.messages.get({ tenantId: tenantB, id: message.id })).resolves.toMatchObject({ acceptanceStatus: "rejected" });
  });
});
