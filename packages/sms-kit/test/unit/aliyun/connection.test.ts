import { describe, expect, it } from "vitest";

import { createAliyunProvider } from "../../../src/aliyun/index.js";
import type { ProviderDeliveryQuery } from "../../../src/ports/index.js";
import { FakeAliyunApi, signFixture, templateFixture } from "../../../src/testing/fake-aliyun-api.js";

const authInput = {
  region: "cn-hangzhou",
  endpoint: "dysmsapi.aliyuncs.com",
  accessKeyId: "access-key-id-reference",
  accessKeySecret: "access-key-secret-reference",
};

describe("AliyunSmsProvider connection checks", () => {
  it("tests list permissions without sending", async () => {
    const api = new FakeAliyunApi()
      .withSignatures([signFixture()])
      .withTemplates([templateFixture()]);
    const secretResolver = {
      resolve: async (reference: string) => `resolved:${reference}`,
    };
    const provider = createAliyunProvider({ api, secretResolver });

    await expect(provider.testConnection(authInput)).resolves.toMatchObject({
      status: "ready",
      signatureCount: 1,
      templateCount: 1,
    });

    expect(api.calls.querySmsSignList).toBe(1);
    expect(api.calls.querySmsTemplateList).toBe(1);
    expect(api.calls.sendSms).toBe(0);
  });

  it("resolves credentials separately for each connection operation", async () => {
    const api = new FakeAliyunApi();
    const resolvedReferences: string[] = [];
    const provider = createAliyunProvider({
      api,
      secretResolver: {
        resolve: async (reference) => {
          resolvedReferences.push(reference);
          return `resolved:${reference}`;
        },
      },
    });

    await provider.testConnection(authInput);

    expect(resolvedReferences).toEqual([
      "access-key-id-reference",
      "access-key-secret-reference",
      "access-key-id-reference",
      "access-key-secret-reference",
    ]);
  });

  it("maps connection transport failures without exposing credential context", async () => {
    const api = new FakeAliyunApi().failSignatureList(
      Object.assign(new Error("request failed for secret-value"), { code: "ECONNRESET" }),
    );
    const provider = createAliyunProvider({
      api,
      secretResolver: { resolve: async (reference) => `resolved:${reference}` },
    });

    const error = await provider.testConnection(authInput).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toMatchObject({ code: "ACCEPTANCE_UNKNOWN", retryable: false });
    expect(error).toHaveProperty("message", "Alibaba Cloud SMS acceptance is unknown");
    expect(JSON.stringify(error)).not.toContain("secret-value");
  });

  it("does not pass credentials into delivery query payloads", async () => {
    const api = new FakeAliyunApi();
    const provider = createAliyunProvider({
      api,
      secretResolver: { resolve: async (reference) => `resolved:${reference}` },
    });
    const input: ProviderDeliveryQuery = {
      ...authInput,
      phoneNumber: "+8613800138000" as ProviderDeliveryQuery["phoneNumber"],
      sendDate: "20260913",
      currentPage: 1,
      pageSize: 20,
      bizId: "biz-1",
    };

    await provider.queryDelivery(input);

    expect(api.lastQueryInput).toEqual({
      phoneNumber: "+8613800138000",
      sendDate: "20260913",
      currentPage: 1,
      pageSize: 20,
      bizId: "biz-1",
    });
  });
});
