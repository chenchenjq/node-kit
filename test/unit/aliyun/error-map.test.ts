import { describe, expect, it } from "vitest";

import { classifyAliyunError } from "../../../src/aliyun/index.js";

describe("classifyAliyunError", () => {
  it("does not include provider credentials in mapped errors", () => {
    const error = classifyAliyunError(new Error("request failed for secret-value"));

    expect(JSON.stringify(error)).not.toContain("secret-value");
  });

  it("retries only allowlisted explicit provider rejections", () => {
    const retryable = classifyAliyunError({ code: "isv.BUSINESS_LIMIT_CONTROL" });
    const nonRetryable = classifyAliyunError({ code: "isv.MOBILE_NUMBER_ILLEGAL" });

    expect(retryable).toMatchObject({
      code: "PROVIDER_THROTTLED",
      retryable: true,
      causeCode: "isv.BUSINESS_LIMIT_CONTROL",
    });
    expect(nonRetryable).toMatchObject({
      code: "PROVIDER_REJECTED",
      retryable: false,
      causeCode: "isv.MOBILE_NUMBER_ILLEGAL",
    });
  });

  it("treats transport failures as acceptance unknown", () => {
    const error = classifyAliyunError(new Error("socket timed out"));

    expect(error).toMatchObject({
      code: "ACCEPTANCE_UNKNOWN",
      retryable: false,
    });
  });

  it("does not treat a transport error code as an explicit provider rejection", () => {
    const transportError = Object.assign(new Error("connection lost for secret-value"), {
      code: "ECONNRESET",
    });

    const error = classifyAliyunError(transportError);

    expect(error).toMatchObject({ code: "ACCEPTANCE_UNKNOWN", retryable: false });
    expect(JSON.stringify(error)).not.toContain("secret-value");
  });
});
