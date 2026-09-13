import { describe, expect, it } from "vitest";

import { SmsKitError } from "../../../src/core/index.js";

describe("SmsKitError", () => {
  it("keeps acceptance uncertainty distinct and non-retryable", () => {
    const error = new SmsKitError("ACCEPTANCE_UNKNOWN", "provider result is unknown", false);

    expect(error.code).toBe("ACCEPTANCE_UNKNOWN");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("provider result is unknown");
  });

  it("preserves immutable array-valued field errors when serialized", () => {
    const suppliedFieldErrors = { recipient: ["invalid"] };
    const error = new SmsKitError(
      "PROVIDER_REJECTED",
      "message was rejected",
      false,
      suppliedFieldErrors,
      "INVALID_PHONE_NUMBER",
    );
    suppliedFieldErrors.recipient.push("untrusted mutation");

    expect(error.fieldErrors).toEqual({ recipient: ["invalid"] });
    expect(JSON.stringify(error)).toBe(
      '{"code":"PROVIDER_REJECTED","message":"message was rejected","retryable":false,"fieldErrors":{"recipient":["invalid"]},"causeCode":"INVALID_PHONE_NUMBER"}',
    );
  });
});
