import { describe, expect, it } from "vitest";

import { EnvSecretResolver } from "../../../src/security/index.js";

describe("EnvSecretResolver", () => {
  it("resolves a present env reference without accepting another scheme", async () => {
    const resolver = new EnvSecretResolver({ SMS_TEST_KEY: "secret-value" });

    await expect(resolver.resolve("env://SMS_TEST_KEY")).resolves.toBe("secret-value");
    await expect(resolver.resolve("file:///tmp/key")).rejects.toMatchObject({
      code: "SECRET_UNRESOLVABLE",
      message: "secret reference is unavailable",
    });
  });

  it("rejects empty and malformed env references without exposing their values", async () => {
    const resolver = new EnvSecretResolver({ EMPTY_SECRET: "", SMS_TEST_KEY: "secret-value" });

    for (const reference of [
      "env://EMPTY_SECRET",
      "env://MISSING_SECRET",
      "env://SMS_TEST_KEY/path",
      "env://sms_test_key",
    ]) {
      await expect(resolver.resolve(reference)).rejects.toMatchObject({
        code: "SECRET_UNRESOLVABLE",
        message: "secret reference is unavailable",
      });
    }
  });
});
