import { describe, expect, it } from "vitest";

import {
  FixedTenantContext,
  createResourceSyncCandidate,
  positiveTimeoutMs,
  type PolicyStore,
  type ProviderDeliveryQuery,
  type ProviderSendInput,
  type SafeEventMetadata,
  type SmsProvider,
  type SmsTransaction,
  type TemplateResourceSnapshot,
} from "../../../src/ports/index.js";
import type { MessageId, TenantId } from "../../../src/core/index.js";

describe("public port contracts", () => {
  it("accepts a concrete provider fake and resolves a trusted fixed tenant", async () => {
    const provider: SmsProvider = {
      testConnection: async () => ({ status: "ready", signatureCount: 1, templateCount: 2 }),
      listSignatures: async () => ({ items: [], nextCursor: undefined }),
      listTemplates: async () => ({ items: [], nextCursor: undefined }),
      send: async () => ({ kind: "accepted", bizId: "biz-1", requestId: "req-1" }),
      queryDelivery: async () => ({ kind: "page", items: [], hasNextPage: false }),
      parseReceipt: () => ({ items: [], acknowledgement: { code: 0, msg: "成功" } }),
    };
    const tenantId = "trusted-tenant" as TenantId;
    const context = new FixedTenantContext(tenantId);

    expect(provider).toBeDefined();
    await expect(Promise.resolve(context.resolve({ untrustedTenantId: "other-tenant" }))).resolves.toBe(tenantId);
  });

  it("rejects non-positive provider timeouts", () => {
    expect(() => positiveTimeoutMs(0)).toThrowError(/positive/);
    expect(positiveTimeoutMs(1)).toBe(1);
  });

  it("requires complete delivery queries and a positive provider timeout", () => {
    const send: ProviderSendInput = {
      region: "cn-hangzhou",
      accessKeyId: "test-access-key-id",
      accessKeySecret: "test-access-key-secret",
      phoneNumber: "+8613800138000" as ProviderSendInput["phoneNumber"],
      signatureName: "Acme",
      templateCode: "SMS_1",
      templateParams: { code: "123456" },
      outId: "message-1",
      timeoutMs: positiveTimeoutMs(1),
    };
    const query: ProviderDeliveryQuery = {
      region: "cn-hangzhou",
      accessKeyId: "test-access-key-id",
      accessKeySecret: "test-access-key-secret",
      phoneNumber: "+8613800138000" as ProviderDeliveryQuery["phoneNumber"],
      sendDate: "20260913",
      currentPage: 1,
      pageSize: 10,
    };

    expect(send.timeoutMs).toBeGreaterThan(0);
    expect(query.currentPage).toBe(1);
  });

  it("uses tenant-scoped policy budget operations", async () => {
    const tenantId = "trusted-tenant" as TenantId;
    const messageId = "message-1" as MessageId;
    const tx = {} as SmsTransaction;
    const policy: PolicyStore = {
      get: async () => ({
        version: 1,
        otpLength: 6,
        otpTtlSeconds: 300,
        otpMaxAttempts: 3,
        proofTtlSeconds: 300,
        phoneMinIntervalSeconds: 60,
        phoneHourlyLimit: 5,
        phoneDailyLimit: 10,
        ipWindowSeconds: 600,
        ipWindowLimit: 20,
        systemDailyBudget: null,
        circuitOpen: false,
      }),
      update: async () => ({
        version: 2,
        otpLength: 6,
        otpTtlSeconds: 300,
        otpMaxAttempts: 3,
        proofTtlSeconds: 300,
        phoneMinIntervalSeconds: 60,
        phoneHourlyLimit: 5,
        phoneDailyLimit: 10,
        ipWindowSeconds: 600,
        ipWindowLimit: 20,
        systemDailyBudget: null,
        circuitOpen: false,
      }),
      holdBudget: async (input) => ({
        messageId: input.messageId,
        budgetDate: "2026-09-13",
        state: "held",
      }),
      releaseBudget: async () => true,
    };

    await expect(policy.holdBudget({ tenantId, messageId, now: new Date("2026-09-13T00:00:00.000Z") }, tx))
      .resolves.toMatchObject({ messageId, state: "held" });
    await expect(policy.releaseBudget({ tenantId, messageId }, tx)).resolves.toBe(true);
  });

  it("accepts only redacted event metadata", () => {
    const safe: SafeEventMetadata = { redactedFields: ["phone"], counts: [{ name: "message", value: 1 }] };
    // @ts-expect-error Event metadata cannot carry arbitrary plaintext fields.
    const unsafe: SafeEventMetadata = { phone: "+8613800138000" };

    expect(safe.redactedFields).toEqual(["phone"]);
    expect(unsafe).toBeDefined();
  });

  it("accepts only finite provider-resource snapshots", () => {
    const signature = createResourceSyncCandidate({
      id: "candidate-signature",
      resourceType: "signature",
      externalKey: "aliyun:sign:1",
      changeType: "new",
      checksum: "checksum-signature",
      snapshot: {
        kind: "signature",
        externalName: "Acme",
        externalStatus: "approved",
        externalType: "general",
      },
    });
    const template = createResourceSyncCandidate({
      id: "candidate-template",
      resourceType: "template",
      externalKey: "aliyun:template:1",
      signatureExternalKey: "aliyun:sign:1",
      templateKey: "verification.code",
      purpose: "verification",
      changeType: "changed",
      checksum: "checksum-template",
      snapshot: {
        kind: "template",
        externalCode: "SMS_1",
        externalName: "Verification",
        externalStatus: "approved",
        templateType: "verification",
        variableNames: ["code"],
      },
    });
    const unsafe: TemplateResourceSnapshot = {
      kind: "template",
      externalCode: "SMS_1",
      externalName: "Verification",
      externalStatus: "approved",
      templateType: "verification",
      variableNames: ["code"],
      // @ts-expect-error Resource snapshots cannot persist raw sensitive fields.
      phone: "+8613800138000",
    };

    expect(signature.snapshot.kind).toBe("signature");
    expect(template.snapshot.kind).toBe("template");
    expect(unsafe).toBeDefined();
  });

  it("projects a preconstructed provider preview before persistence", () => {
    const untrustedPreview = {
      id: "candidate-template",
      resourceType: "template" as const,
      externalKey: "aliyun:template:1",
      signatureExternalKey: "aliyun:sign:1",
      templateKey: "verification.code",
      purpose: "verification",
      changeType: "new" as const,
      checksum: "checksum-template",
      snapshot: {
        kind: "template" as const,
        externalCode: "SMS_1",
        externalName: "Verification",
        externalStatus: "approved",
        templateType: "verification" as const,
        variableNames: ["code"],
        phone: "sensitive-input",
      },
    };

    const candidate = createResourceSyncCandidate(untrustedPreview);

    expect(candidate.snapshot).toEqual({
      kind: "template",
      externalCode: "SMS_1",
      externalName: "Verification",
      externalStatus: "approved",
      templateType: "verification",
      variableNames: ["code"],
    });
    expect("phone" in candidate.snapshot).toBe(false);
    expect(Object.isFrozen(candidate)).toBe(true);
  });

  it.each(["a..b", ".start", "end-"])("uses the core template-key grammar for resource selections: %s", (templateKey) => {
    expect(() => createResourceSyncCandidate({
      id: "candidate-template-invalid",
      resourceType: "template",
      externalKey: "aliyun:template:invalid",
      signatureExternalKey: "aliyun:sign:1",
      templateKey,
      purpose: "verification",
      changeType: "new",
      checksum: "checksum-invalid",
      snapshot: {
        kind: "template",
        externalCode: "SMS_INVALID",
        externalName: "Invalid",
        externalStatus: "approved",
        templateType: "verification",
        variableNames: ["code"],
      },
    })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
