import { describe, expect, it } from "vitest";

import {
  apiFailureSchema,
  messageDetailDtoSchema,
  messageDtoSchema,
  phoneDtoSchema,
  providerConfigDtoSchema,
  resourceSyncPreviewInputSchema,
  secretRefDtoSchema,
  smsStatsDtoSchema,
  updateProviderConfigSchema,
  updateVerificationSettingsInputSchema,
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
    betterAuth: {
      adapterStatus: "enabled",
      loginTemplateKey: "auth.login_otp",
      passwordResetTemplateKey: "auth.password_reset",
    },
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

function configuredProviderFixture(endpoint: string) {
  return {
    provider: "aliyun" as const,
    status: "ready" as const,
    enabled: true,
    region: "cn-hangzhou",
    endpoint,
    accessKeyIdRef: { scheme: "vault", maskedName: "ALIYUN_***_ID", configured: true },
    accessKeySecretRef: { scheme: "vault", maskedName: "ALIYUN_***_SECRET", configured: true },
    receiptCallbackTokenRef: { scheme: "vault", maskedName: "CALLBACK_***_TOKEN", configured: true },
    lastTestStatus: "succeeded" as const,
    lastTestedAt: "2026-09-13T00:00:00.000Z",
    version: 1,
  };
}

function providerUpdateFixture(endpoint: string) {
  return {
    version: 1,
    idempotencyKey: "config:endpoint",
    region: "cn-hangzhou",
    endpoint,
    accessKeyIdRef: "vault://sms/aliyun/access-key-id",
    accessKeySecretRef: "vault://sms/aliyun/access-key-secret",
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

  it("rejects a full phone number in the masked phone field", () => {
    expect(phoneDtoSchema.parse({ masked: "***0000", last4Available: true })).toEqual({
      masked: "***0000",
      last4Available: true,
    });
    expect(() => phoneDtoSchema.parse({ masked: "+8613800138000", last4Available: true })).toThrow();
    expect(() => phoneDtoSchema.parse({ masked: "13800138000", last4Available: true })).toThrow();
  });

  it.each([
    ["AccessKey ID", "LTAI5tExampleAccessKey"],
    ["AccessKey Secret", "example-access-key-secret"],
    ["callback token", "callback-token-example"],
  ])("rejects a raw %s in a masked secret reference", (_label, rawSecret) => {
    expect(() => secretRefDtoSchema.parse({
      scheme: "env",
      maskedName: rawSecret,
      configured: true,
    })).toThrow();
  });

  it.each([
    ["complete env reference", "env://ALIYUN_SECRET"],
    ["reference path", "vault/sms/aliyun"],
    ["userinfo-like credential", "user:secret@vault"],
    ["query payload", "env?token=callback-token-example"],
    ["fragment payload", "env#callback-token-example"],
  ])("rejects non-identifier secret reference scheme content: %s", (_label, scheme) => {
    expect(() => secretRefDtoSchema.parse({
      scheme,
      maskedName: "ALIYUN_***_SECRET",
      configured: true,
    })).toThrow();
  });

  it.each([
    ["AccessKey ID after the marker", "***LTAI5tExampleAccessKey"],
    ["AccessKey ID before the marker", "LTAI5tExampleAccessKey***"],
    ["AccessKey ID after a delimiter", "***_LTAI5tExampleAccessKey"],
    ["AccessKey Secret after the marker", "***example-access-key-secret"],
    ["AccessKey Secret before the marker", "example-access-key-secret***"],
    ["AccessKey Secret before a delimiter", "example-access-key-secret_***"],
    ["callback token after the marker", "***MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"],
    ["callback token before the marker", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY***"],
    ["callback token after a delimiter", "***_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"],
  ])("rejects a complete %s in maskedName", (_label, maskedName) => {
    expect(() => secretRefDtoSchema.parse({
      scheme: "env",
      maskedName,
      configured: true,
    })).toThrow();
  });

  it.each([
    "ALIYUN_***",
    "***_SECRET",
    "ALIYUN***SECRET",
    "ALIYUN_****_SECRET",
    "aliyun_***_secret",
    "ALIYUN_***_SECRET_EXTRA",
    "TOO_LONG_***_SECRET",
  ])("rejects non-canonical masked secret name %s", (maskedName) => {
    expect(() => secretRefDtoSchema.parse({
      scheme: "env",
      maskedName,
      configured: true,
    })).toThrow();
  });

  it("accepts ordinary redacted secret reference names", () => {
    for (const maskedName of ["***", "ALIYUN_***_SECRET", "CALLBACK_***_TOKEN", "A1_***_Z9"]) {
      expect(secretRefDtoSchema.parse({
        scheme: "env",
        maskedName,
        configured: true,
      })).toEqual({ scheme: "env", maskedName, configured: true });
    }
  });

  it("represents a host-registered secret scheme as a redacted identifier", () => {
    const dto = secretRefDtoSchema.parse({
      scheme: "vault",
      maskedName: "ALIYUN_***_SECRET",
      configured: true,
    });

    expect(dto).toEqual({ scheme: "vault", maskedName: "ALIYUN_***_SECRET", configured: true });
    expect(JSON.stringify(dto)).not.toContain("vault://");
  });

  it("keeps verification policy and provider versions independent", () => {
    const dto = verificationSettingsDtoSchema.parse(verificationFixture({
      version: 4,
      systemDailyBudget: null,
      circuitOpen: false,
    }));

    expect(dto.version).toBe(4);
    expect(dto.systemDailyBudget).toBeNull();
    expect(dto.betterAuth).toEqual({
      adapterStatus: "enabled",
      loginTemplateKey: "auth.login_otp",
      passwordResetTemplateKey: "auth.password_reset",
    });
    expect(dto).not.toHaveProperty("providerConfigVersion");
  });

  it("models truthful Better Auth host state but keeps mappings read-only", () => {
    expect(verificationSettingsDtoSchema.parse(verificationFixture({
      betterAuth: { adapterStatus: "not_configured", loginTemplateKey: null, passwordResetTemplateKey: null },
    })).betterAuth.adapterStatus).toBe("not_configured");
    expect(() => verificationSettingsDtoSchema.parse(verificationFixture({
      betterAuth: { adapterStatus: "enabled", loginTemplateKey: null, passwordResetTemplateKey: null },
    }))).toThrow();

    const { betterAuth: _readOnlyMapping, ...policy } = verificationFixture();
    expect(() => updateVerificationSettingsInputSchema.parse({
      ...policy,
      idempotencyKey: "verification:mapping-must-be-host-owned",
      betterAuth: { adapterStatus: "disabled", loginTemplateKey: null, passwordResetTemplateKey: null },
    })).toThrow();
  });

  it("keeps message-detail diagnostics useful but rejects transport tokens and raw payload fields", () => {
    const detail = messageDetailDtoSchema.parse({
      ...messageDtoFixture(),
      version: 1,
      providerRequestId: "request-1",
      attempts: [{
        attemptNo: 1,
        status: "accepted",
        dispatchMode: "queued",
        dispatchMarkedAt: "2026-09-13T00:00:00.000Z",
        occurredAt: "2026-09-13T00:00:00.100Z",
        providerRequestId: "attempt-request-1",
        latencyMs: 100,
      }],
      receipts: [{
        source: "callback",
        deliveryStatus: "delivered",
        occurredAt: "2026-09-13T00:00:01.000Z",
        receivedAt: "2026-09-13T00:00:01.100Z",
        diagnostics: { redactedFields: ["phone", "template-params"], reportCount: 1 },
      }],
      diagnostics: { redactedFields: ["phone"], counts: [{ name: "attempt", value: 1 }] },
    });

    expect(detail).toMatchObject({ providerRequestId: "request-1", attempts: [{ attemptNo: 1 }], receipts: [{ source: "callback" }] });
    expect(() => messageDetailDtoSchema.parse({ ...detail, dispatchToken: "internal-token" })).toThrow();
    expect(() => messageDetailDtoSchema.parse({
      ...detail,
      receipts: [{ ...detail.receipts[0], rawPayload: { phone: "+8613800138000" } }],
    })).toThrow();
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

  it("keeps host-registered schemes available to configuration references", () => {
    const input = {
      version: 1,
      idempotencyKey: "config:custom-scheme",
      region: "cn-hangzhou",
      accessKeyIdRef: "vault://sms/aliyun/access-key-id",
      accessKeySecretRef: "vault://sms/aliyun/access-key-secret",
    };

    expect(updateProviderConfigSchema.parse(input)).toMatchObject(input);
  });

  it.each([
    "https://dysmsapi.aliyuncs.com",
    "HTTPS://dysmsapi.aliyuncs.com",
    "https://sms.example.test:8443",
    "https://[2001:db8::1]:8443",
    "https://dysmsapi.aliyuncs.com/",
  ])("accepts and preserves credential-free HTTPS provider origin %s", (endpoint) => {
    expect(updateProviderConfigSchema.parse(providerUpdateFixture(endpoint)).endpoint).toBe(endpoint);
    expect(providerConfigDtoSchema.parse(configuredProviderFixture(endpoint))).toMatchObject({ endpoint });
  });

  it.each([
    ["userinfo", "https://access-key:secret@dysmsapi.aliyuncs.com"],
    ["empty userinfo", "https://@dysmsapi.aliyuncs.com"],
    ["empty username and password", "https://:@dysmsapi.aliyuncs.com"],
    ["path", "https://dysmsapi.aliyuncs.com/proxy"],
    ["normalized dot path", "https://dysmsapi.aliyuncs.com/a/.."],
    ["percent-encoded dot path", "https://dysmsapi.aliyuncs.com/%2e"],
    ["query", "https://dysmsapi.aliyuncs.com?access_key=secret"],
    ["fragment", "https://dysmsapi.aliyuncs.com#secret-token"],
  ])("rejects an HTTPS provider endpoint containing %s in public input and output DTOs", (_label, endpoint) => {
    expect(() => updateProviderConfigSchema.parse(providerUpdateFixture(endpoint))).toThrow();
    expect(() => providerConfigDtoSchema.parse(configuredProviderFixture(endpoint))).toThrow();
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
