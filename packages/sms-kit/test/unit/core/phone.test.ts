import { describe, expect, it } from "vitest";

import { maskMainlandPhone, normalizeMainlandPhone, normalizeMainlandNationalPhone } from "../../../src/core/index.js";

describe("mainland phone validation", () => {
  it.each(["13800138000", "+8613800138000", "+08613800138000", "008613800138000", "138 0013 8000"])("normalizes %s to eleven storage digits", (input) => {
    expect(normalizeMainlandNationalPhone(input)).toBe("13800138000");
  });
  it.each(["call 13800138000", "+85251234567", "138****8000", "9913800138000", "13800138000x"])("rejects unsafe national input %s", (input) => {
    expect(() => normalizeMainlandNationalPhone(input)).toThrow();
  });
  it.each([
    ["13800138000", "+8613800138000"],
    ["+86 138 0013 8000", "+8613800138000"],
  ])("normalizes %s to E.164", (input, expected) => {
    expect(normalizeMainlandPhone(input)).toBe(expected);
  });

  it("rejects a Hong Kong number", () => {
    expect(() => normalizeMainlandPhone("+85251234567")).toThrowError(/mainland China/);
  });

  it("rejects masked phone values", () => {
    expect(() => normalizeMainlandPhone("138****8000")).toThrowError(/mainland China/);
  });

  it("masks the national number while preserving its first and last four digits", () => {
    const phone = normalizeMainlandPhone("13800138000");

    expect(maskMainlandPhone(phone)).toBe("138****8000");
  });
});
