import { ALIYUN_RECEIPT_MAX_BODY_BYTES } from "../aliyun/receipt.js";
import { SmsKitError } from "../core/errors.js";
import type { Clock } from "../ports/runtime.js";

const acknowledgement = Object.freeze({ code: 0, msg: "成功" });
const callbackDeadlineMs = 700;
const callbackSafetyMarginMs = 50;
const callbackTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type AliyunReceiptIngestor = Readonly<{
  ingest(input: Readonly<{
    token: string;
    body: string | Uint8Array;
    deadlineAt: Date;
    signal: AbortSignal;
  }>): Promise<unknown>;
}>;

export type AliyunReceiptHandlerOptions = Readonly<{
  receiptService: AliyunReceiptIngestor;
  clock: Clock;
  /**
   * The host authenticates the opaque path segment before this adapter reads
   * the request stream. ReceiptService repeats the check before persistence.
   */
  verifyToken(token: string): boolean | Promise<boolean>;
  maxBodyBytes?: number;
  safetyMarginMs?: number;
}>;

function callbackResponse(status: number, error?: string, retryable = false): Response {
  return Response.json(error === undefined ? acknowledgement : { error, retryable }, { status });
}

function pathToken(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname;
  const segments = pathname.split("/");
  const encoded = segments.at(-1);
  if (encoded === undefined || encoded.length === 0 || !callbackTokenPattern.test(encoded)) return undefined;
  return encoded;
}

function declaredBodyIsNonempty(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) return request.body !== null;
  if (!/^[0-9]+$/.test(contentLength)) return true;
  return BigInt(contentLength) !== 0n || request.body !== null;
}

function contentLengthExceeds(request: Request, maximum: number): boolean {
  const contentLength = request.headers.get("content-length");
  return contentLength !== null && /^[0-9]+$/.test(contentLength) && BigInt(contentLength) > BigInt(maximum);
}

function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
}

class ReceiptDeadlineError extends Error {
  constructor() { super("receipt callback deadline reached"); }
}

type ReceiptDeadline = Readonly<{
  signal: AbortSignal;
  assertActive(): void;
  run<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T>;
  dispose(): void;
}>;

function deadlineError(signal: AbortSignal): ReceiptDeadlineError {
  return signal.reason instanceof ReceiptDeadlineError ? signal.reason : new ReceiptDeadlineError();
}

function createReceiptDeadline(clock: Clock, deadlineAt: Date, safetyMarginMs: number): ReceiptDeadline {
  const controller = new AbortController();
  const remainingMs = Math.min(
    callbackDeadlineMs - safetyMarginMs,
    deadlineAt.getTime() - clock.now().getTime() - safetyMarginMs,
  );
  const monotonicDeadlineAt = performance.now() + remainingMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    controller.abort(new ReceiptDeadlineError());
  } else {
    timer = setTimeout(() => controller.abort(new ReceiptDeadlineError()), remainingMs);
  }

  const assertActive = (): void => {
    if (!Number.isFinite(deadlineAt.getTime()) ||
        deadlineAt.getTime() - clock.now().getTime() <= safetyMarginMs ||
        performance.now() >= monotonicDeadlineAt) {
      controller.abort(new ReceiptDeadlineError());
    }
    if (controller.signal.aborted) throw deadlineError(controller.signal);
  };

  return {
    signal: controller.signal,
    assertActive,
    run<T>(operation: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = (): void => finish(() => reject(deadlineError(controller.signal)));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        void Promise.resolve().then(() => {
          assertActive();
          return operation(controller.signal);
        }).then(
          (value) => {
            try {
              assertActive();
              finish(() => resolve(value));
            } catch (error) {
              finish(() => reject(error));
            }
          },
          (error: unknown) => {
            try {
              assertActive();
              finish(() => reject(error));
            } catch (deadlineFailure) {
              finish(() => reject(deadlineFailure));
            }
          },
        );
      });
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best-effort; the HTTP response must not wait for it.
  }
}

async function readReceiptBody(request: Request, maximum: number, signal: AbortSignal): Promise<string> {
  if (contentLengthExceeds(request, maximum)) throw new ReceiptHttpError(413);
  if (request.body === null) throw new ReceiptHttpError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = (): void => cancelReader(reader, signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) {
      cancel();
      throw deadlineError(signal);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw deadlineError(signal);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        cancelReader(reader);
        throw new ReceiptHttpError(413);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReceiptHttpError(400);
  }
}

class ReceiptHttpError extends Error {
  constructor(readonly status: 400 | 413) { super("invalid callback request"); }
}

function serviceFailure(error: unknown): Response {
  if (error instanceof ReceiptDeadlineError) return callbackResponse(503, "callback temporarily unavailable", true);
  if (error instanceof SmsKitError && error.retryable) return callbackResponse(503, "callback temporarily unavailable", true);
  if (error instanceof SmsKitError && error.code === "CONFIG_INVALID") return callbackResponse(400, "invalid callback request");
  if (error instanceof SmsKitError && error.code === "PERMISSION_DENIED") return callbackResponse(401, "invalid callback token");
  return callbackResponse(500, "callback failed");
}

/**
 * Creates the public Alibaba callback boundary. The path token is checked
 * before a body stream is acquired; no callback field can select a tenant.
 */
export function createAliyunReceiptHandler(options: AliyunReceiptHandlerOptions) {
  const maximum = options.maxBodyBytes ?? ALIYUN_RECEIPT_MAX_BODY_BYTES;
  const safetyMarginMs = options.safetyMarginMs ?? callbackSafetyMarginMs;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > ALIYUN_RECEIPT_MAX_BODY_BYTES) {
    throw new RangeError("receipt maxBodyBytes must be between 1 and the Aliyun callback limit");
  }
  if (!Number.isFinite(safetyMarginMs) || safetyMarginMs < 0 || safetyMarginMs >= callbackDeadlineMs) {
    throw new RangeError("receipt safetyMarginMs must be non-negative and below the callback deadline");
  }

  return async (request: Request): Promise<Response> => {
    const receivedAt = options.clock.now();
    const token = pathToken(request);
    if (token === undefined) return callbackResponse(401, "invalid callback token");
    const deadlineAt = new Date(receivedAt.getTime() + callbackDeadlineMs);
    const deadline = createReceiptDeadline(options.clock, deadlineAt, safetyMarginMs);
    try {
      try {
        if (!(await deadline.run(() => options.verifyToken(token)))) return callbackResponse(401, "invalid callback token");
      } catch (error) {
        if (error instanceof ReceiptDeadlineError) throw error;
        return callbackResponse(401, "invalid callback token");
      }

      if (request.method === "GET") {
        if (new URL(request.url).search.length !== 0 || request.headers.has("content-type") || declaredBodyIsNonempty(request)) {
          return callbackResponse(400, "invalid callback request");
        }
        deadline.assertActive();
        return callbackResponse(200);
      }
      if (request.method !== "POST") return callbackResponse(405, "invalid callback request");
      if (new URL(request.url).search.length !== 0 || !isJsonContentType(request)) return callbackResponse(400, "invalid callback request");

      const body = await deadline.run((signal) => readReceiptBody(request, maximum, signal));
      await deadline.run((signal) => options.receiptService.ingest({ token, body, deadlineAt, signal }));
      deadline.assertActive();
      return callbackResponse(200);
    } catch (error) {
      if (error instanceof ReceiptHttpError) return callbackResponse(error.status, "invalid callback request");
      return serviceFailure(error);
    } finally {
      deadline.dispose();
    }
  };
}
