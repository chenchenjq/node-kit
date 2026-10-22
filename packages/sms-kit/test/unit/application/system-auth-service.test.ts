import { describe, expect, it } from "vitest";

import { SystemAuthSmsService } from "../../../src/application/system-auth-service.js";
import type { MessageId } from "../../../src/core/types.js";
import type { PhoneNumberProtector } from "../../../src/ports/security.js";
import { AesGcmPhoneNumberProtector } from "../../../src/security/aes-gcm-protector.js";
import { HmacHasher } from "../../../src/security/hmac-hasher.js";

const now = new Date("2026-09-21T00:00:00.000Z");

function fixture(phoneProtector?: PhoneNumberProtector) {
  const protectedContexts: unknown[] = [];
  const rateLimitCalls: unknown[] = [];
  const messages: unknown[] = [];
  const challenges: any[] = [];
  const service = new SystemAuthSmsService({
    store: {
      transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      config: { get: async () => ({ provider: "aliyun", region: "cn-hangzhou", accessKeyIdRef: "key", accessKeySecretRef: "secret", receiptCallbackTokenRef: "token", status: "ready", enabled: true, lastTestStatus: "succeeded", version: 1 }) },
      policy: {
        get: async () => ({ version: 1, otpLength: 6, otpTtlSeconds: 300, otpMaxAttempts: 5, proofTtlSeconds: 300, phoneMinIntervalSeconds: 60, phoneHourlyLimit: 5, phoneDailyLimit: 10, ipWindowSeconds: 3600, ipWindowLimit: 20, systemDailyBudget: null, circuitOpen: false }),
        holdBudget: async () => ({ messageId: "message-1", budgetDate: "2026-09-21", state: "held" }),
        releaseBudget: async () => true,
      },
      resources: {
        findTemplateByKey: async () => ({ id: "template-1", signatureId: "signature-1", templateKey: "auth.login_otp", externalCode: "SMS_1", externalName: "Login", externalStatus: "approved", templateType: "verification", purpose: "auth.login_otp", variables: [{ name: "code", sensitive: true }], enabled: true, version: 1 }),
        findSignatureById: async () => ({ id: "signature-1", externalKey: "sign-1", externalName: "Hoobee", externalStatus: "approved", externalType: "enterprise", enabled: true, version: 1 }),
      },
      rateLimits: {
        lock: async (input: unknown) => { rateLimitCalls.push(input); },
        increment: async (input: unknown) => { rateLimitCalls.push(input); return 1; },
        countSince: async () => 1,
      },
      audits: { append: async (event: unknown) => event },
    } as never,
    repository: {
      getChallengeByIdempotency: async () => undefined,
      invalidateActiveChallenges: async () => undefined,
      createChallenge: async (input: any) => { const challenge = { ...input, attemptCount: 0, deliveryAcceptanceStatus: "pending" }; challenges.push(challenge); return challenge; },
      createMessage: async (input: any) => { messages.push(input); return { id: input.id, created: true }; },
      startAttempt: async () => "dispatch-token",
      completeAttempt: async () => undefined,
      recoverAbandoned: async () => 0,
      applyReceipt: async () => ({ matched: false, terminalConflict: false }),
      scheduleReconciliation: async () => undefined,
      leaseReconciliation: async () => [],
      completeQueryReconciliation: async () => undefined,
      finishTerminalReconciliation: async () => undefined,
      rescheduleReconciliation: async () => undefined,
      finalizeUnknownReconciliation: async () => undefined,
      markMessageAcceptance: async () => undefined,
      markChallengeDelivery: async (input: any) => { challenges[0].deliveryAcceptanceStatus = input.status; return challenges[0]; },
      getChallengeForUpdate: async () => undefined,
      incrementChallengeAttempts: async () => { throw new Error("not expected"); },
      verifyChallenge: async () => { throw new Error("not expected"); },
      consumeProof: async () => { throw new Error("not expected"); },
    },
    provider: { send: async () => ({ kind: "accepted", bizId: "biz-1", requestId: "request-1" }) } as never,
    phoneProtector: phoneProtector ?? { protect: async (_phone: string, context: unknown) => { protectedContexts.push(context); return { ciphertext: "cipher", keyId: "key-1", lookupHash: "phone-hash", last4: "0000", masked: "138****0000" }; } },
    hasher: { hash: async (value: string) => `hash:${value}`, verify: async () => false },
    clock: { now: () => now },
    ids: { next: () => "challenge-1", messageId: () => "message-1" as MessageId },
    providerTimeoutMs: 1_000,
    otpGenerator: { generate: () => "123456" },
  });
  return { service, protectedContexts, rateLimitCalls, messages, challenges };
}

describe("SystemAuthSmsService", () => {
  it("can decrypt the persisted SYSTEM phone using its message id and rejects another record", async () => {
    const key = Buffer.alloc(32, 7);
    const protector = new AesGcmPhoneNumberProtector({
      activeKey: async () => ({ id: "key-1", bytes: key }),
      keyById: async () => key,
    }, new HmacHasher(Buffer.alloc(32, 8)));
    const subject = fixture(protector);
    await subject.service.issue({ subjectId: "user-1", action: "login.authenticate", phone: "13800138000", idempotencyKey: "login:1" });
    const message = subject.messages[0] as { id: MessageId; phoneCiphertext: string; phoneKeyId: string };
    const encrypted = { ciphertext: message.phoneCiphertext, keyId: message.phoneKeyId };
    const context = { envelopeVersion: 1, purpose: "phone", tenantId: null, recordId: message.id, fieldName: "phone_ciphertext" } as const;

    await expect(protector.unprotect(encrypted, context)).resolves.toBe("+8613800138000");
    await expect(protector.unprotect(encrypted, { ...context, recordId: "another-message" as MessageId }))
      .rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  });

  it("issues a login challenge in SYSTEM scope without a tenant sentinel", async () => {
    const subject = fixture();

    await expect(subject.service.issue({ subjectId: "user-1", action: "login.authenticate", phone: "13800138000", ipAddress: "203.0.113.10", idempotencyKey: "login:1" }))
      .resolves.toEqual({ id: "challenge-1", expiresAt: new Date("2026-09-21T00:05:00.000Z") });

    expect(subject.protectedContexts).toEqual([expect.objectContaining({ tenantId: null })]);
    expect(subject.rateLimitCalls).toContainEqual(expect.objectContaining({ ownership: { scopeType: "SYSTEM" } }));
    expect(subject.messages).toEqual([expect.objectContaining({ idempotencyKey: "system-auth:challenge-1", templateKey: "auth.login_otp" })]);
    expect(subject.challenges).toEqual([expect.objectContaining({ action: "login.authenticate", purpose: "login_otp" })]);
  });
});
