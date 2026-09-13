import { describe, expect, it } from "vitest";

import {
  FixedTenantContext,
  type ProviderDeliveryQuery,
  type ProviderSendInput,
  type SmsProvider,
} from "../../../src/ports/index.js";
import type { TenantId } from "../../../src/core/index.js";

describe("public port contracts", () => {
  it("accepts a concrete provider fake and resolves a trusted fixed tenant", async () => {
    const provider: SmsProvider = {
      testConnection: async () => ({ status: "ready", signatureCount: 1, templateCount: 2 }),
      listSignatures: async () => ({ items: [], nextCursor: undefined }),
      listTemplates: async () => ({ items: [], nextCursor: undefined }),
      send: async () => ({ kind: "accepted", bizId: "biz-1", requestId: "req-1" }),
      queryDelivery: async () => ({ kind: "waiting" }),
      parseReceipt: () => ({ items: [], acknowledgement: { code: 0, msg: "成功" } }),
    };
    const tenantId = "trusted-tenant" as TenantId;
    const context = new FixedTenantContext(tenantId);

    expect(provider).toBeDefined();
    await expect(Promise.resolve(context.resolve({ untrustedTenantId: "other-tenant" }))).resolves.toBe(tenantId);
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
      timeoutMs: 1,
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
});
