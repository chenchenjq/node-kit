import { describe, expect, it } from "vitest";

import {
  apiFailureSchema,
  messageDtoSchema,
  resourceSyncPreviewInputSchema,
  smsStatsDtoSchema,
  updateProviderConfigSchema,
  verificationSettingsDtoSchema,
} from "../../../src/next/types/index.js";

function messageDtoFixture() {
  return {
    id: "message-1",
    phone: { masked: "138****8000", last4Available: true },
    templateKey: "notice.shipped",
    purpose: "notification",
    acceptanceStatus: "accepted",
    deliveryStatus: "waiting",
    submittedAt: "2026-09-13T00:00:00.000Z",
    attemptCount: 1,
  };
}

function verificationFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    otpLength: 6,
    otpTtlSeconds: 300,
    otpMaxAttempts: 3,
    proofTtlSeconds: 300,
    phoneMinIntervalSeconds: 60,
    phoneHourlyLimit: 5,
    phoneDailyLimit: 10,
    ipWindowSeconds: 600,
    ipWindowLimit: 20,
    systemDailyBudget: 500,
    circuitOpen: false,
    ...overrides,
  };
}

function statsFixture() {
  return {
    submitted: 10,
    accepted: 7,
    acceptanceRejected: 2,
    acceptanceUnknown: 1,
    deliveryWaiting: 2,
    delivered: 4,
    deliveryFailed: 1,
    deliveryUnknownFinal: 0,
    retry: 3,
  };
}

describe("public Next admin DTO contracts", () => {
  it("rejects unknown config fields", () => {
    const input = {
      version: 1,
      idempotencyKey: "config:1",
      region: "cn-hangzhou",
      accessKeyIdRef: "env://ALIYUN_ID",
      accessKeySecretRef: "env://ALIYUN_SECRET",
    };

    expect(updateProviderConfigSchema.parse(input)).toMatchObject(input);
    expect(() => updateProviderConfigSchema.parse({
      ...input,
      leakedSecret: "value",
    })).toThrow();
  });

  it("does not expose a full phone field on MessageDto", () => {
    const dto = messageDtoSchema.parse(messageDtoFixture());

    expect(dto.phone).toEqual({ masked: "138****8000", last4Available: true });
    expect(JSON.stringify(dto)).not.toContain("+8613800138000");
    expect(() => messageDtoSchema.parse({ ...messageDtoFixture(), phoneNumber: "+8613800138000" })).toThrow();
  });

  it("keeps verification policy and provider versions independent", () => {
    const dto = verificationSettingsDtoSchema.parse(verificationFixture({
      version: 4,
      systemDailyBudget: null,
      circuitOpen: false,
    }));

    expect(dto.version).toBe(4);
    expect(dto.systemDailyBudget).toBeNull();
    expect(dto).not.toHaveProperty("providerConfigVersion");
  });

  it("uses explicit acceptance and delivery statistic fields", () => {
    const dto = smsStatsDtoSchema.parse(statsFixture());

    expect(dto).toMatchObject({
      submitted: 10,
      accepted: 7,
      acceptanceRejected: 2,
      acceptanceUnknown: 1,
      deliveryWaiting: 2,
      delivered: 4,
      deliveryFailed: 1,
      deliveryUnknownFinal: 0,
      retry: 3,
    });
    expect(dto).not.toHaveProperty("failed");
    expect(dto).not.toHaveProperty("unknown");
    expect(() => smsStatsDtoSchema.parse({ ...statsFixture(), failed: 1 })).toThrow();
  });

  it("keeps error envelopes on the stable, redacted error-code boundary", () => {
    expect(apiFailureSchema.parse({
      error: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable", retryable: true },
      requestId: "req-1",
    })).toEqual({
      error: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable", retryable: true },
      requestId: "req-1",
    });
    expect(() => apiFailureSchema.parse({
      error: { code: "unknown-provider-code", message: "unsafe provider message", retryable: false },
      requestId: "req-1",
    })).toThrow();
  });

  it("accepts only scheme-qualified secret references", () => {
    const input = {
      version: 1,
      idempotencyKey: "config:1",
      region: "cn-hangzhou",
      accessKeyIdRef: "env://ALIYUN_ID",
      accessKeySecretRef: "env://ALIYUN_SECRET",
    };

    expect(updateProviderConfigSchema.parse(input)).toMatchObject(input);
    expect(() => updateProviderConfigSchema.parse({ ...input, accessKeySecretRef: "AKIA-raw-secret" })).toThrow();
  });

  it("requires a versioned write for a resource sync preview", () => {
    const input = { version: 2, idempotencyKey: "sync:1" };

    expect(resourceSyncPreviewInputSchema.parse(input)).toEqual(input);
    expect(() => resourceSyncPreviewInputSchema.parse({ idempotencyKey: "sync:1" })).toThrow();
  });

  it("accepts only UTC timestamps in public message DTOs", () => {
    expect(messageDtoSchema.parse(messageDtoFixture()).submittedAt).toBe("2026-09-13T00:00:00.000Z");
    expect(() => messageDtoSchema.parse({ ...messageDtoFixture(), submittedAt: "2026-09-13T08:00:00+08:00" })).toThrow();
  });
});
