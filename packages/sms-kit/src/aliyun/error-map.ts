import { SmsKitError } from "../core/errors.js";

export type AliyunFailureClass =
  | { kind: "rejected"; retryable: false; code: string }
  | { kind: "rejected"; retryable: true; code: string }
  | { kind: "unknown"; retryable: false; code: "ACCEPTANCE_UNKNOWN" };

// These response codes explicitly reject the request before SMS acceptance.
const RETRYABLE_REJECTION_CODES = new Set([
  "isv.BUSINESS_LIMIT_CONTROL",
]);

// Only machine-readable Alibaba response codes that this adapter recognizes
// may cross the provider boundary. Unknown `code` fields can originate in a
// transport or SDK error and therefore leave acceptance uncertain.
const NON_RETRYABLE_REJECTION_CODES = new Set([
  "isv.MOBILE_NUMBER_ILLEGAL",
]);

function providerCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

export function classifyAliyunFailure(error: unknown): AliyunFailureClass {
  const code = providerCode(error);
  if (
    code === undefined
    || (!RETRYABLE_REJECTION_CODES.has(code) && !NON_RETRYABLE_REJECTION_CODES.has(code))
  ) {
    return { kind: "unknown", retryable: false, code: "ACCEPTANCE_UNKNOWN" };
  }

  return {
    kind: "rejected",
    retryable: RETRYABLE_REJECTION_CODES.has(code),
    code,
  };
}

/**
 * Maps only the provider's machine-readable code. Provider messages often carry
 * request context, so they are deliberately never copied into application errors.
 */
export function classifyAliyunError(error: unknown): SmsKitError {
  const failure = classifyAliyunFailure(error);
  if (failure.kind === "unknown") {
    return new SmsKitError(
      "ACCEPTANCE_UNKNOWN",
      "Alibaba Cloud SMS acceptance is unknown",
      false,
    );
  }

  return new SmsKitError(
    failure.retryable ? "PROVIDER_THROTTLED" : "PROVIDER_REJECTED",
    "Alibaba Cloud SMS rejected the request",
    failure.retryable,
    undefined,
    failure.code,
  );
}
