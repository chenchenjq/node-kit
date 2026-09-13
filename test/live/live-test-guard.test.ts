import { describe, expect, it } from "vitest";

import { assertLiveTestGuard, assertReadOnlyLiveGuard, isTestResourceName } from "./live-test-guard.js";

describe("Aliyun live-test guards", () => {
  it("rejects opt-in unless every safety value and allowlist entry is present", () => {
    expect(() => assertLiveTestGuard({ SMS_KIT_LIVE_TEST: "1" })).toThrowError(/allowlist/);
  });

  it("accepts only an explicitly allowlisted mainland test recipient", () => {
    const configuration = {
      SMS_KIT_LIVE_TEST: "1",
      SMS_KIT_LIVE_NON_PRODUCTION: "1",
      SMS_KIT_LIVE_ALLOW_SEND: "1",
      SMS_KIT_LIVE_ACCESS_KEY_ID_REF: "env://SMS_KIT_TEST_ACCESS_KEY_ID",
      SMS_KIT_LIVE_ACCESS_KEY_SECRET_REF: "env://SMS_KIT_TEST_ACCESS_KEY_SECRET",
      SMS_KIT_TEST_ACCESS_KEY_ID: "provided-at-runtime",
      SMS_KIT_TEST_ACCESS_KEY_SECRET: "provided-at-runtime",
      SMS_KIT_LIVE_PHONE: "+8613800138000",
      SMS_KIT_LIVE_PHONE_ALLOWLIST: "+8613800138000",
      SMS_KIT_LIVE_SIGN_NAME: "SMS KIT 测试",
      SMS_KIT_LIVE_TEMPLATE_CODE: "SMS_TEST_001",
      SMS_KIT_LIVE_TEMPLATE_PARAMS: "{\"code\":\"000000\"}",
    };

    expect(assertLiveTestGuard(configuration)).toMatchObject({
      phone: "+8613800138000",
      signatureName: "SMS KIT 测试",
      templateCode: "SMS_TEST_001",
      templateParams: { code: "000000" },
      accessKeyIdRef: "env://SMS_KIT_TEST_ACCESS_KEY_ID",
      accessKeySecretRef: "env://SMS_KIT_TEST_ACCESS_KEY_SECRET",
    });
    expect(JSON.stringify(assertLiveTestGuard(configuration))).not.toContain("provided-at-runtime");
  });

  it("rejects production or unmarked signature and template resources", () => {
    expect(isTestResourceName("SMS KIT 测试签名")).toBe(true);
    expect(isTestResourceName("Production Marketing")).toBe(false);
  });

  it("rejects missing non-production and one-send acknowledgements", () => {
    expect(() => assertLiveTestGuard({
      SMS_KIT_LIVE_TEST: "1",
      SMS_KIT_LIVE_PHONE: "+8613800138000",
      SMS_KIT_LIVE_PHONE_ALLOWLIST: "+8613800138000",
    })).toThrowError(/NON_PRODUCTION/);
  });

  it("keeps read-only connection opt-in separate from the one-message opt-in", () => {
    expect(() => assertReadOnlyLiveGuard({ SMS_KIT_LIVE_CONNECTION_TEST: "1" })).toThrowError(/NON_PRODUCTION/);
    expect(() => assertLiveTestGuard({ SMS_KIT_LIVE_CONNECTION_TEST: "1" })).toThrowError(/SMS_KIT_LIVE_TEST/);
  });

  it("rejects a recipient outside the explicit allowlist", () => {
    expect(() => assertLiveTestGuard({
      SMS_KIT_LIVE_TEST: "1",
      SMS_KIT_LIVE_NON_PRODUCTION: "1",
      SMS_KIT_LIVE_ALLOW_SEND: "1",
      SMS_KIT_LIVE_ACCESS_KEY_ID_REF: "env://SMS_KIT_TEST_ACCESS_KEY_ID",
      SMS_KIT_LIVE_ACCESS_KEY_SECRET_REF: "env://SMS_KIT_TEST_ACCESS_KEY_SECRET",
      SMS_KIT_TEST_ACCESS_KEY_ID: "not-a-secret-placeholder",
      SMS_KIT_TEST_ACCESS_KEY_SECRET: "not-a-secret-placeholder",
      SMS_KIT_LIVE_PHONE: "+8613800138000",
      SMS_KIT_LIVE_PHONE_ALLOWLIST: "+8613800138001",
      SMS_KIT_LIVE_SIGN_NAME: "SMS KIT 测试",
      SMS_KIT_LIVE_TEMPLATE_CODE: "SMS_TEST_001",
      SMS_KIT_LIVE_TEMPLATE_PARAMS: "{\"code\":\"000000\"}",
    })).toThrowError(/must be present in/);
  });
});
