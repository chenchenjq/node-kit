import { describe, expect, it } from "vitest";

import { validateTemplateKey, validateTemplateVariables } from "../../../src/core/index.js";

describe("template validation", () => {
  it.each(["login.code", "sms-template_2", "promo-v1.test"]) (
    "accepts template key %s",
    (key) => expect(() => validateTemplateKey(key)).not.toThrow(),
  );

  it.each(["", "Login.Code", "a..b", ".start", "end-", "with space"]) (
    "rejects malformed template key %s",
    (key) => expect(() => validateTemplateKey(key)).toThrowError(/template key/),
  );

  it("requires an exact variable set", () => {
    expect(() => validateTemplateVariables(["code"], { code: "123456", extra: "x" }))
      .toThrowError(/unexpected variable: extra/);
  });

  it("reports missing variables", () => {
    expect(() => validateTemplateVariables(["code", "name"], { code: "123456" }))
      .toThrowError(/missing variable: name/);
  });
});
