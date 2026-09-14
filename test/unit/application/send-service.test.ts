import { describe, expect, it } from "vitest";

import { SendService } from "../../../src/application/send-service.js";
import type { Template } from "../../../src/ports/store.js";
import type { TenantId } from "../../../src/core/types.js";

const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;
function template(type: Template["templateType"]): Template {
  return { id: "template-1" as Template["id"], signatureId: "signature-1", templateKey: type === "verification" ? "otp.login" : "order.shipped",
    externalCode: "SMS_ORDER", externalName: "Order", externalStatus: "approved", templateType: type,
    purpose: type === "verification" ? "verification" : "notification", variables: [{ name: type === "verification" ? "code" : "orderNo", sensitive: false }], enabled: true, version: 1 };
}

function fixture(circuitOpen = false, templateType: Template["templateType"] = "notification", configured = true) {
  const messages = new Map<string, any>();
  const attempts: any[] = [];
  const reservations: any[] = [];
  let providerCalls = 0;
  let sendEntered: (() => void) | undefined;
  let release: ((value: any) => void) | undefined;
  const sendGate = new Promise((resolve) => { release = resolve; });
  const store = {
    transaction: async (work: any) => work({}),
    resources: {
      findTemplateByKey: async () => template(templateType),
      // Sends take a transaction-scoped shared lock through the parent lookup
      // so a concurrent stable-key mutation cannot orphan its snapshot.
      findSignatureById: async () => ({ id: "signature-1", externalName: "Kit", enabled: true, externalStatus: "approved" }),
      listSignatures: async () => ({ items: [{ id: "signature-1", externalName: "Kit", enabled: true, externalStatus: "approved" }], total: 1 }),
    },
    config: { get: async () => ({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "id", accessKeySecretRef: "secret", receiptCallbackTokenRef: "token", status: configured ? "ready" : "untested", enabled: configured }) },
    messages: {
      createWithSendJob: async (input: any) => {
        const key = `${input.tenantId}:${input.idempotencyKey}`;
        const existing = messages.get(key);
        if (existing) return { message: existing, created: false };
        const message = { ...input, acceptanceStatus: "pending", deliveryStatus: "not_applicable", metadata: {}, version: 1 };
        messages.set(key, message); return { message, created: true };
      },
      completeAcceptance: async (input: any) => {
        const message = [...messages.values()].find((value) => value.id === attempts.find((attempt) => attempt.dispatchToken === input.dispatchToken)?.messageId)!;
        Object.assign(message, { acceptanceStatus: input.status, deliveryStatus: input.status === "rejected" ? "not_applicable" : "waiting" }); return message;
      },
    },
    policy: {
      get: async () => ({ phoneMinIntervalSeconds: 0, phoneHourlyLimit: 10, phoneDailyLimit: 10, circuitOpen }),
      holdBudget: async (input: any) => { const held = { messageId: input.messageId, state: "held" }; reservations.push(held); return held; },
      releaseBudget: async () => true,
    },
    rateLimits: { lock: async () => undefined, increment: async () => 1, countSince: async () => 1 },
    attempts: {
      createStarted: async (input: any) => { const attempt = { ...input, id: "attempt-1", dispatchToken: "dispatch-1", status: "started" }; attempts.push(attempt); return attempt; },
      completeByDispatchToken: async () => attempts[0],
    },
    jobs: { ensureReconcile: async () => undefined },
  };
  const service = new SendService({
    store: store as never,
    provider: { send: async () => { providerCalls += 1; sendEntered?.(); await sendGate; return { kind: "accepted", bizId: "biz-1", requestId: "req-1" }; } } as never,
    phoneProtector: { protect: async () => ({ ciphertext: "enc-phone", keyId: "phone-k1", lookupHash: "phone-hash", last4: "0000", masked: "138****0000" }) } as never,
    payloadProtector: { seal: async () => ({ ciphertext: "enc-payload", keyId: "payload-k1" }) } as never,
    clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
    ids: { messageId: () => `message-${messages.size + 1}` as any, next: () => "job-1" },
    events: { emit: () => undefined }, providerTimeoutMs: 1_000,
  });
  return { service, messages, attempts, reservations, provider: { get calls() { return providerCalls; }, deferNextSend: () => undefined, waitUntilSendCalled: () => new Promise<void>((resolve) => { sendEntered = resolve; }), resolveNextSend: (result: any) => release!(result) } };
}

const input = { tenantId: tenantA, templateKey: "order.shipped", phone: "13800138000", variables: { orderNo: "A-100" }, purpose: "notification", idempotencyKey: "order:A-100:shipped" };

describe("SendService", () => {
  it("stores encrypted variables for a queued notification", async () => {
    const { service, messages } = fixture();
    const result = await service.enqueueNotification(input);
    const stored = [...messages.values()].find((message) => message.id === result.id)!;
    expect(stored.renderParamsCiphertext).not.toContain("A-100");
    expect(stored.renderParamsKeyId).toBe("payload-k1");
  });

  it("returns the original queued message for the same tenant idempotency key", async () => {
    const { service } = fixture();
    const first = await service.enqueueNotification(input);
    const second = await service.enqueueNotification(input);
    expect(second.id).toBe(first.id);
  });

  it("isolates queued idempotency by tenant", async () => {
    const { service } = fixture();
    const first = await service.enqueueNotification(input);
    const second = await service.enqueueNotification({ ...input, tenantId: tenantB });
    expect(second.id).not.toBe(first.id);
  });

  it("commits direct budget and marker before the OTP provider call", async () => {
    const { service, attempts, reservations, provider } = fixture(false, "verification");
    const pending = service.sendOtpNow({ tenantId: tenantA, templateKey: "otp.login", phone: "13800138000", variables: { code: "123456" }, purpose: "verification", idempotencyKey: "otp-1" });
    await provider.waitUntilSendCalled();
    expect(attempts[0]).toMatchObject({ dispatchMode: "direct", status: "started" });
    expect(attempts[0]?.leaseToken).toBeUndefined();
    expect(reservations[0]).toMatchObject({ state: "held" });
    provider.resolveNextSend({ kind: "accepted", bizId: "biz-1", requestId: "req-1" });
    await pending;
  });

  it("rejects real direct sends while the circuit is open", async () => {
    const { service, provider } = fixture(true, "verification");
    await expect(service.sendOtpNow({ tenantId: tenantA, templateKey: "otp.login", phone: "13800138000", variables: { code: "123456" }, purpose: "verification", idempotencyKey: "otp-2" })).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
    expect(provider.calls).toBe(0);
  });

  it("keeps notifications queued and verification templates direct", async () => {
    const notification = fixture();
    await expect(notification.service.sendOtpNow(input)).rejects.toMatchObject({ code: "TEMPLATE_UNAVAILABLE" });
    const verification = fixture(false, "verification");
    await expect(verification.service.enqueueNotification({ tenantId: tenantA, templateKey: "otp.login", phone: "13800138000", variables: { code: "123456" }, purpose: "verification", idempotencyKey: "queue-otp" })).rejects.toMatchObject({ code: "TEMPLATE_UNAVAILABLE" });
    expect(notification.messages.size).toBe(0);
    expect(verification.messages.size).toBe(0);
  });

  it("rejects invalid local provider configuration before persisting a direct dispatch marker", async () => {
    const { service, messages, attempts, reservations, provider } = fixture(false, "verification", false);
    await expect(service.sendOtpNow({ tenantId: tenantA, templateKey: "otp.login", phone: "13800138000", variables: { code: "123456" }, purpose: "verification", idempotencyKey: "bad-config" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(messages.size).toBe(0); expect(attempts).toHaveLength(0); expect(reservations).toHaveLength(0); expect(provider.calls).toBe(0);
  });
});
