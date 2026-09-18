import { expect, it } from "vitest";

import { AreaKitError, sanitizeError } from "../src/errors.js";

it("sanitizes database failures without copying the original message", () => {
  const error = sanitizeError(new Error("postgres://secret@host/private"));

  expect(error).toBeInstanceOf(AreaKitError);
  expect(error.toJSON()).toEqual({ code: "QUERY_FAILED", message: "区域查询失败" });
  expect(JSON.stringify(error)).not.toContain("secret");
});

it("preserves branded errors across independent server bundles without trusting lookalikes", async () => {
  const { vi } = await import("vitest");
  vi.resetModules();
  const otherBundle = await import("../src/errors.js");
  expect(otherBundle.AreaKitError).not.toBe(AreaKitError);
  class SelectionRejection extends otherBundle.AreaKitError {
    override toJSON() { return { ...super.toJSON(), reason: "NAVIGATION_ONLY" }; }
  }
  const foreign = new SelectionRejection("TARGET_LEVEL_NOT_REACHED");
  expect(sanitizeError(foreign).toJSON()).toEqual({
    code: "TARGET_LEVEL_NOT_REACHED", message: "未达到目标层级", reason: "NAVIGATION_ONLY",
  });
  expect(sanitizeError(new otherBundle.AreaKitError("FORBIDDEN")).code).toBe("FORBIDDEN");
  expect(sanitizeError(Object.assign(new Error("secret"), {name: "AreaKitError", code: "FORBIDDEN"})).code).toBe("QUERY_FAILED");
});
