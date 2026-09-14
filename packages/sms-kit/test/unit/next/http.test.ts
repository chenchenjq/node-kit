import { describe, expect, it } from "vitest";

import { failure, parseJsonBody, success } from "../../../src/next/http.js";
import { SmsKitError } from "../../../src/core/errors.js";

function streamedRequest(chunks: readonly string[], headers: HeadersInit = {}): Request {
  const encoder = new TextEncoder();
  return new Request("https://app.test/api/admin/sms/config", {
    method: "POST",
    headers,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

describe("Next admin HTTP utilities", () => {
  it("returns the documented success envelope", async () => {
    const response = success({ enabled: true }, "req-1", 201);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { enabled: true }, requestId: "req-1" });
  });

  it("uses a safe stable envelope for unknown failures", async () => {
    const response = failure(new Error("postgres password=not-for-clients"), "req-1");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "STORAGE_FAILURE", message: "request failed", retryable: false },
      requestId: "req-1",
    });
  });

  it("maps SmsKitError to a safe stable envelope without its cause or field details", async () => {
    const response = failure(new SmsKitError(
      "RATE_LIMITED",
      "too many requests",
      true,
      { phone: ["try again later"] },
      "provider-private-cause",
    ), "req-1");

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "rate limit exceeded",
        retryable: true,
      },
      requestId: "req-1",
    });
  });

  it("maps a known storage failure to a safe server error", async () => {
    const response = failure(new SmsKitError("STORAGE_FAILURE", "database password=not-for-clients"), "req-1");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "STORAGE_FAILURE", message: "request failed", retryable: false },
      requestId: "req-1",
    });
  });

  it("rejects a declared body larger than the configured byte limit before reading it", async () => {
    const request = streamedRequest(["{}"], { "content-length": "11" });

    await expect(parseJsonBody(request, 10)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a streamed body that crosses the configured byte limit", async () => {
    const request = streamedRequest(["{\"value\":\"", "1234567890", "\"}"], { "content-length": "not-a-number" });

    await expect(parseJsonBody(request, 20)).rejects.toMatchObject({ status: 413 });
  });

  it("maps malformed JSON to a client error without exposing parser details", async () => {
    const request = streamedRequest(["{not json"]);

    await expect(parseJsonBody(request, 100)).rejects.toMatchObject({ status: 400, message: "invalid JSON body" });
  });
});
