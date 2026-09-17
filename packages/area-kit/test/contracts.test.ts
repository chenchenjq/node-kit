import { expect, it } from "vitest";

import { AreaKitError, sanitizeError } from "../src/errors.js";

it("sanitizes database failures without copying the original message", () => {
  const error = sanitizeError(new Error("postgres://secret@host/private"));

  expect(error).toBeInstanceOf(AreaKitError);
  expect(error.toJSON()).toEqual({ code: "QUERY_FAILED", message: "区域查询失败" });
  expect(JSON.stringify(error)).not.toContain("secret");
});
