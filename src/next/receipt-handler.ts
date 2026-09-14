import { ALIYUN_RECEIPT_MAX_BODY_BYTES } from "../aliyun/receipt.js";
import { SmsKitError } from "../core/errors.js";
import type { Clock } from "../ports/runtime.js";

const acknowledgement = Object.freeze({ code: 0, msg: "成功" });
const callbackDeadlineMs = 700;
const callbackSafetyMarginMs = 50;
const callbackTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export type AliyunReceiptIngestor = Readonly<{
  ingest(input: Readonly<{ token: string; body: string | Uint8Array; deadlineAt: Date }>): Promise<unknown>;
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

function deadlineReached(clock: Clock, deadlineAt: Date, safetyMarginMs: number): boolean {
  return !Number.isFinite(deadlineAt.getTime()) || deadlineAt.getTime() - clock.now().getTime() < safetyMarginMs;
}

async function readReceiptBody(request: Request, maximum: number): Promise<string> {
  if (contentLengthExceeds(request, maximum)) throw new ReceiptHttpError(413);
  if (request.body === null) throw new ReceiptHttpError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ReceiptHttpError(413);
      }
      chunks.push(value);
    }
  } finally {
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
    try {
      if (!(await options.verifyToken(token))) return callbackResponse(401, "invalid callback token");
    } catch {
      return callbackResponse(401, "invalid callback token");
    }

    const deadlineAt = new Date(receivedAt.getTime() + callbackDeadlineMs);
    if (deadlineReached(options.clock, deadlineAt, safetyMarginMs)) {
      return callbackResponse(503, "callback temporarily unavailable", true);
    }

    if (request.method === "GET") {
      if (new URL(request.url).search.length !== 0 || request.headers.has("content-type") || declaredBodyIsNonempty(request)) {
        return callbackResponse(400, "invalid callback request");
      }
      return callbackResponse(200);
    }
    if (request.method !== "POST") return callbackResponse(405, "invalid callback request");
    if (new URL(request.url).search.length !== 0 || !isJsonContentType(request)) return callbackResponse(400, "invalid callback request");

    try {
      const body = await readReceiptBody(request, maximum);
      if (deadlineReached(options.clock, deadlineAt, safetyMarginMs)) {
        return callbackResponse(503, "callback temporarily unavailable", true);
      }
      await options.receiptService.ingest({ token, body, deadlineAt });
      return callbackResponse(200);
    } catch (error) {
      if (error instanceof ReceiptHttpError) return callbackResponse(error.status, "invalid callback request");
      return serviceFailure(error);
    }
  };
}
