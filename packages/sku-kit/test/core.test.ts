import { describe, expect, it } from "vitest";

import {
  buildCombinationKey,
  calculatePotentialCombinations,
  normalizeSpecificationLabel,
  validateCnyAmount,
} from "../src/index.js";

describe("sales specification core", () => {
  it("normalizes labels for duplicate detection without changing units", () => {
    expect(normalizeSpecificationLabel("  Red\u00a0\u00a0Color ")).toBe("red color");
    expect(normalizeSpecificationLabel("500g")).not.toBe(normalizeSpecificationLabel("0.5kg"));
  });

  it("creates an order-independent stable combination key", () => {
    expect(buildCombinationKey([
      { dimensionId: "size", valueId: "m" },
      { dimensionId: "color", valueId: "red" },
    ])).toBe('v1:[["color","red"],["size","m"]]');
    expect(buildCombinationKey([])).toBe("v1:[]");
  });

  it("rejects potential combinations over the hard cap before materialization", () => {
    expect(calculatePotentialCombinations([10, 10], 100)).toEqual({ ok: true, count: 100 });
    expect(calculatePotentialCombinations([10, 11], 100)).toEqual({ ok: false, count: 110 });
  });

  it("validates CNY amounts without rounding", () => {
    expect(validateCnyAmount("0")).toEqual({ ok: true, value: "0.00" });
    expect(validateCnyAmount("9999999999999999.99")).toEqual({ ok: true, value: "9999999999999999.99" });
    expect(validateCnyAmount("1.999").ok).toBe(false);
    expect(validateCnyAmount("-1").ok).toBe(false);
  });
});
