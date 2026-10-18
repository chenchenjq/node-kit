import { describe, expect, it } from "vitest";
import { AuthKitError, errorResponse } from "../src/server/errors.js";

describe("error response baseline", () => {
  it("formats AuthKitError into standard public error JSON", async () => {
    const error = new AuthKitError("RATE_LIMITED", 429, Date.now() + 60000);
    const response = errorResponse(error, Date.now());

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBeDefined();

    const body = await response.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toBe("操作频繁，请稍后重试");
    expect(body.retryAt).toBeDefined();
    expect(body.serverTime).toBeTypeOf("number");
  });

  it("handles unknown error as UNAVAILABLE 503", async () => {
    const response = errorResponse(new Error("unexpected crash"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe("UNAVAILABLE");
    expect(body.error.message).toBe("服务暂时不可用，请稍后重试");
  });
});

