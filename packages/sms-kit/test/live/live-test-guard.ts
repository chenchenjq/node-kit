import { normalizeMainlandPhone } from "../../src/core/phone.js";

export type LiveTestConfiguration = Readonly<{
  accessKeyIdRef: string;
  accessKeySecretRef: string;
  phone: string;
  signatureName: string;
  templateCode: string;
  templateParams: Readonly<Record<string, string>>;
}>;
export type ReadOnlyLiveTestConfiguration = Readonly<{
  accessKeyIdRef: string;
  accessKeySecretRef: string;
}>;

const ENV_REFERENCE = /^env:\/\/([A-Z_][A-Z0-9_]*)$/;
let sendClaimed = false;

function required(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Missing required live-test value: ${key}`);
  return value;
}

function requiredTestSecretReference(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const reference = required(environment, key);
  const variableName = ENV_REFERENCE.exec(reference)?.[1];
  if (variableName === undefined || !variableName.includes("TEST")) {
    throw new Error(`${key} must reference a test-only environment variable`);
  }
  // Confirm presence without returning, interpolating, or logging the credential.
  if (environment[variableName]?.trim() === undefined || environment[variableName]!.trim().length === 0) {
    throw new Error(`${key} points to an unavailable test credential`);
  }
  return reference;
}

function parseAllowlist(value: string): Set<string> {
  const phones = value.split(/[\s,]+/).filter(Boolean);
  if (phones.length === 0) throw new Error("SMS_KIT_LIVE_PHONE_ALLOWLIST must contain a test phone number");
  try {
    return new Set(phones.map((phone) => normalizeMainlandPhone(phone)));
  } catch {
    throw new Error("SMS_KIT_LIVE_PHONE_ALLOWLIST contains an invalid mainland phone number");
  }
}

function parseTemplateParams(value: string): Readonly<Record<string, string>> {
  if (value.length > 2_000) throw new Error("SMS_KIT_LIVE_TEMPLATE_PARAMS is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SMS_KIT_LIVE_TEMPLATE_PARAMS must be a JSON object of string values");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      !Object.entries(parsed).every(([key, item]) => key.length > 0 && typeof item === "string")) {
    throw new Error("SMS_KIT_LIVE_TEMPLATE_PARAMS must be a JSON object of string values");
  }
  return parsed as Record<string, string>;
}

export function isTestResourceName(name: string): boolean {
  return /(?:\btest\b|测试)/i.test(name);
}

/** Allows only an explicitly opted-in, test-credential, read-only provider connection check. */
export function assertReadOnlyLiveGuard(
  environment: Readonly<Record<string, string | undefined>>,
): ReadOnlyLiveTestConfiguration {
  if (environment.SMS_KIT_LIVE_CONNECTION_TEST !== "1") {
    throw new Error("Set SMS_KIT_LIVE_CONNECTION_TEST=1 to opt in to the read-only Aliyun connection check");
  }
  if (required(environment, "SMS_KIT_LIVE_NON_PRODUCTION") !== "1") {
    throw new Error("SMS_KIT_LIVE_NON_PRODUCTION must equal 1 after confirming test-only Aliyun credentials");
  }
  return {
    accessKeyIdRef: requiredTestSecretReference(environment, "SMS_KIT_LIVE_ACCESS_KEY_ID_REF"),
    accessKeySecretRef: requiredTestSecretReference(environment, "SMS_KIT_LIVE_ACCESS_KEY_SECRET_REF"),
  };
}

/** Validates opt-in before any provider call and returns no resolved credentials. */
export function assertLiveTestGuard(
  environment: Readonly<Record<string, string | undefined>>,
): LiveTestConfiguration {
  if (environment.SMS_KIT_LIVE_TEST !== "1") throw new Error("Set SMS_KIT_LIVE_TEST=1 to opt in to Aliyun live tests");
  const allowlistValue = environment.SMS_KIT_LIVE_PHONE_ALLOWLIST?.trim();
  if (allowlistValue === undefined || allowlistValue.length === 0) {
    throw new Error("Missing required live-test allowlist value: SMS_KIT_LIVE_PHONE_ALLOWLIST");
  }
  if (required(environment, "SMS_KIT_LIVE_NON_PRODUCTION") !== "1") {
    throw new Error("SMS_KIT_LIVE_NON_PRODUCTION must equal 1 after confirming test-only Aliyun resources");
  }
  if (required(environment, "SMS_KIT_LIVE_ALLOW_SEND") !== "1") {
    throw new Error("SMS_KIT_LIVE_ALLOW_SEND must equal 1 to authorize the single test message");
  }

  const credentials = {
    accessKeyIdRef: requiredTestSecretReference(environment, "SMS_KIT_LIVE_ACCESS_KEY_ID_REF"),
    accessKeySecretRef: requiredTestSecretReference(environment, "SMS_KIT_LIVE_ACCESS_KEY_SECRET_REF"),
  };
  const phone = normalizeMainlandPhone(required(environment, "SMS_KIT_LIVE_PHONE"));
  const allowlist = parseAllowlist(allowlistValue);
  if (!allowlist.has(phone)) throw new Error("SMS_KIT_LIVE_PHONE must be present in SMS_KIT_LIVE_PHONE_ALLOWLIST");

  const signatureName = required(environment, "SMS_KIT_LIVE_SIGN_NAME");
  if (!isTestResourceName(signatureName)) throw new Error("SMS_KIT_LIVE_SIGN_NAME must identify a test-only Aliyun signature");
  const templateCode = required(environment, "SMS_KIT_LIVE_TEMPLATE_CODE");
  return {
    ...credentials,
    phone,
    signatureName,
    templateCode,
    templateParams: parseTemplateParams(required(environment, "SMS_KIT_LIVE_TEMPLATE_PARAMS")),
  };
}

/** Atomically enforces at most one outbound message in this test process. */
export function claimSingleLiveSend(): void {
  if (sendClaimed) throw new Error("Aliyun live tests allow at most one send per process");
  sendClaimed = true;
}
