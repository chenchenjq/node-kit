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
  clock?: Readonly<{ now(): Date }>;
  clockValues?: readonly Date[];
  verifyToken?: (value: string) => boolean | Promise<boolean>;
  ingest?: (input: Readonly<{
    token: string;
    body: string | Uint8Array;
    deadlineAt: Date;
    signal: AbortSignal;
  }>) => Promise<Readonly<{ acknowledgement: typeof acknowledgement }>>;
}>) {
  const values = [...(options.clockValues ?? [new Date("2026-09-13T00:00:00.000Z")])];
  const clock = options.clock ?? { now: () => values.shift() ?? new Date("2026-09-13T00:00:00.000Z") };
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
      signal: expect.any(AbortSignal),
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

  it("returns retryable 503 when a fast ingest advances the injected clock beyond the response budget", async () => {
    const startedAt = new Date("2026-09-13T00:00:00.000Z");
    let current = startedAt;
    const receiptHandler = handler({
      clock: { now: () => new Date(current) },
      ingest: async () => {
        current = new Date(startedAt.getTime() + 651);
        return { acknowledgement };
      },
    });

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
  });

  it("returns retryable 503 when synchronous ingest work consumes 800ms while the injected clock is fixed", async () => {
    let monotonicElapsedMs = 0;
    const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => monotonicElapsedMs);
    try {
      const receiptHandler = handler({
        clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
        ingest: async () => {
          // Model an 800ms synchronous block without making the test wait on
          // real time or relying on the timer callback getting a turn.
          monotonicElapsedMs += 800;
          return { acknowledgement };
        },
      });

      const response = await receiptHandler.callback(request("POST", receipt));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
    } finally {
      performanceNow.mockRestore();
    }
  });

  it("prioritizes the deadline when a verifier advances the injected clock and then rejects", async () => {
    const startedAt = new Date("2026-09-13T00:00:00.000Z");
    let current = startedAt;
    const receiptHandler = handler({
      clock: { now: () => new Date(current) },
      verifyToken: async () => {
        current = new Date(startedAt.getTime() + 651);
        throw new Error("verifier failed after deadline");
      },
    });

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
    expect(receiptHandler.ingest).not.toHaveBeenCalled();
  });

  it("preserves a verifier rejection while the injected clock remains active", async () => {
    const receiptHandler = handler({
      verifyToken: async () => { throw new Error("verifier unavailable"); },
    });

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid callback token", retryable: false });
    expect(receiptHandler.ingest).not.toHaveBeenCalled();
  });

  it("prioritizes the deadline when ingest advances the injected clock and then rejects", async () => {
    const startedAt = new Date("2026-09-13T00:00:00.000Z");
    let current = startedAt;
    const receiptHandler = handler({
      clock: { now: () => new Date(current) },
      ingest: async () => {
        current = new Date(startedAt.getTime() + 651);
        throw new Error("ingest failed after deadline");
      },
    });

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
  });

  it("returns retryable 503 and cancels an endless body stream even if the injected clock moves backwards", async () => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receiptHandler = handler({ clockValues: [
        new Date("2026-09-13T00:00:00.000Z"),
        new Date("2026-09-12T23:59:59.000Z"),
      ] });
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        cancel() {
          cancelled = true;
          return Promise.reject(new Error("stream cancellation failed"));
        },
      });
      const callback = new Request(`https://sms.example.test/api/sms/receipt/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit);
      const response = receiptHandler.callback(callback);
      const responseOrGuard = Promise.race([
        response,
        new Promise<"test guard">((resolve) => {
          guardTimer = setTimeout(() => resolve("test guard"), 651);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(651);
      const result = await responseOrGuard;

      expect(result).not.toBe("test guard");
      if (result === "test guard") return;
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
      expect(cancelled).toBe(true);
      await Promise.resolve();
      expect(body.locked).toBe(false);
      expect(receiptHandler.ingest).not.toHaveBeenCalled();
    } finally {
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      try { controller?.error(new Error("test stream cleanup")); } catch { /* stream was cancelled */ }
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("returns retryable 503 and aborts a hanging receipt ingest at the callback deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let rejectIngest: ((reason: Error) => void) | undefined;
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const receiptHandler = handler({
        ingest: async (input) => {
          signal = input.signal;
          return await new Promise<never>((_resolve, reject) => { rejectIngest = reject; });
        },
      });
      const response = receiptHandler.callback(request("POST", receipt));
      const responseOrGuard = Promise.race([
        response,
        new Promise<"test guard">((resolve) => {
          guardTimer = setTimeout(() => resolve("test guard"), 651);
        }),
      ]);

      await vi.advanceTimersByTimeAsync(651);
      const result = await responseOrGuard;

      expect(result).not.toBe("test guard");
      if (result === "test guard") return;
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
      expect(signal?.aborted).toBe(true);

      rejectIngest?.(new Error("late ingest failure"));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      if (guardTimer !== undefined) clearTimeout(guardTimer);
      rejectIngest?.(new Error("test ingest cleanup"));
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("bounds a hanging token verifier without starting to consume the callback body", async () => {
    vi.useFakeTimers();
    let pulls = 0;
    try {
      const receiptHandler = handler({ verifyToken: async () => new Promise<boolean>(() => undefined) });
      const body = new ReadableStream<Uint8Array>({ pull() { pulls += 1; } });
      const response = receiptHandler.callback(new Request(`https://sms.example.test/api/sms/receipt/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit));

      await vi.advanceTimersByTimeAsync(651);

      expect((await response).status).toBe(503);
      expect(pulls).toBeLessThanOrEqual(1);
      expect(body.locked).toBe(false);
      expect(receiptHandler.ingest).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not disclose receipt service failures", async () => {
    const receiptHandler = handler({ ingest: async () => { throw new Error("postgres://user:password@private-host"); } });

    const response = await receiptHandler.callback(request("POST", receipt));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "callback failed", retryable: false });
  });
});
