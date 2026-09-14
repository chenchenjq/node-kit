import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAliyunReceiptHandler } from "../../../src/next/index.js";

const token = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const acknowledgement = { code: 0, msg: "成功" };
const receipt = JSON.stringify([{
  phone_number: "13800138000",
  biz_id: "biz-1",
  out_id: "message-1",
  send_time: "2026-09-13 08:00:00",
  report_time: "2026-09-13 08:00:01",
  success: true,
  err_code: "DELIVERED",
  err_msg: "ok",
  sms_size: "1",
}]);

function request(method: "GET" | "POST", body?: string, tokenValue = token): Request {
  return new Request(`https://sms.example.test/api/sms/receipt/${tokenValue}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
  });
}

function handler(options: Readonly<{
  clockValues?: readonly Date[];
  verifyToken?: (value: string) => boolean | Promise<boolean>;
  ingest?: (input: Readonly<{ token: string; body: string | Uint8Array; deadlineAt: Date }>) => Promise<Readonly<{ acknowledgement: typeof acknowledgement }>>;
}>) {
  const values = [...(options.clockValues ?? [new Date("2026-09-13T00:00:00.000Z")])];
  const clock = { now: () => values.shift() ?? new Date("2026-09-13T00:00:00.000Z") };
  const ingest = vi.fn(options.ingest ?? (async () => ({ acknowledgement })));
  return {
    ingest,
    callback: createAliyunReceiptHandler({
      clock,
      receiptService: { ingest },
      verifyToken: options.verifyToken ?? ((value) => value === token),
    }),
  };
}

describe("Aliyun receipt Route Handler", () => {
  it("acknowledges a verified POST receipt with Alibaba's required response", async () => {
    const receiptHandler = handler({});

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(acknowledgement);
    expect(receiptHandler.ingest).toHaveBeenCalledWith({
      token,
      body: receipt,
      deadlineAt: new Date("2026-09-13T00:00:00.700Z"),
    });
  });

  it("accepts only a bodyless verified GET connectivity check", async () => {
    const receiptHandler = handler({});

    const response = await receiptHandler.callback(request("GET"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(acknowledgement);
    expect(receiptHandler.ingest).not.toHaveBeenCalled();
  });

  it("validates the path token before reading a callback body", async () => {
    const receiptHandler = handler({ verifyToken: () => false });
    const body = new ReadableStream<Uint8Array>({
      pull() { throw new Error("callback body must remain unread"); },
    });
    const callback = new Request(`https://sms.example.test/api/sms/receipt/${token}`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);

    const response = await receiptHandler.callback(callback);

    expect(response.status).toBe(401);
    expect(receiptHandler.ingest).not.toHaveBeenCalled();
  });

  it("rejects an oversized callback before it reaches receipt persistence", async () => {
    const receiptHandler = handler({});

    const response = await receiptHandler.callback(request("POST", "x".repeat(65_537)));

    expect(response.status).toBe(413);
    expect(receiptHandler.ingest).not.toHaveBeenCalled();
  });

  it("preserves the 413 response when cancelling an oversized stream rejects", async () => {
    const receiptHandler = handler({});
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { return Promise.reject(new Error("stream cancellation failed")); },
    });
    const callback = new Request(`https://sms.example.test/api/sms/receipt/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    const response = await receiptHandler.callback(callback);

    expect(response.status).toBe(413);
    expect(receiptHandler.ingest).not.toHaveBeenCalled();
  });

  it("returns retryable 503 before parsing or delegating near the 700ms deadline", async () => {
    const receiptHandler = handler({ clockValues: [
      new Date("2026-09-13T00:00:00.000Z"),
      new Date("2026-09-13T00:00:00.690Z"),
    ] });

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
    expect(receiptHandler.ingest).not.toHaveBeenCalled();
  });

  it("does not disclose receipt service failures", async () => {
    const receiptHandler = handler({ ingest: async () => { throw new Error("postgres://user:password@private-host"); } });

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "callback failed", retryable: false });
  });
});
