import { describe, expect, it } from "vitest";

import { OtpGenerator } from "../../../src/security/otp-generator.js";

describe("OtpGenerator", () => {
  it("returns a zero-padded decimal code at the requested length", () => {
    const generator = new OtpGenerator();

    expect(generator.generate(6)).toMatch(/^\d{6}$/);
    expect(generator.generate(4)).toMatch(/^\d{4}$/);
  });
});
