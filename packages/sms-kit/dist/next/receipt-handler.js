import { ALIYUN_RECEIPT_MAX_BODY_BYTES } from "../aliyun/receipt.js";
import { SmsKitError } from "../core/errors.js";
const acknowledgement = Object.freeze({ code: 0, msg: "成功" });
const callbackDeadlineMs = 700;
const callbackSafetyMarginMs = 50;
const callbackTokenPattern = /^[A-Za-z0-9_-]{43}$/;
function callbackResponse(status, error, retryable = false) {
    return Response.json(error === undefined ? acknowledgement : { error, retryable }, { status });
}
function pathToken(request) {
    const pathname = new URL(request.url).pathname;
    const segments = pathname.split("/");
    const encoded = segments.at(-1);
    if (encoded === undefined || encoded.length === 0 || !callbackTokenPattern.test(encoded))
        return undefined;
    return encoded;
}
function declaredBodyIsNonempty(request) {
    const contentLength = request.headers.get("content-length");
    if (contentLength === null)
        return request.body !== null;
    if (!/^[0-9]+$/.test(contentLength))
        return true;
    return BigInt(contentLength) !== 0n || request.body !== null;
}
function contentLengthExceeds(request, maximum) {
    const contentLength = request.headers.get("content-length");
    return contentLength !== null && /^[0-9]+$/.test(contentLength) && BigInt(contentLength) > BigInt(maximum);
}
function isJsonContentType(request) {
    const contentType = request.headers.get("content-type");
    return contentType !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType);
}
class ReceiptDeadlineError extends Error {
    constructor() { super("receipt callback deadline reached"); }
}
function deadlineError(signal) {
    return signal.reason instanceof ReceiptDeadlineError ? signal.reason : new ReceiptDeadlineError();
}
function createReceiptDeadline(clock, deadlineAt, safetyMarginMs) {
    const controller = new AbortController();
    const remainingMs = Math.min(callbackDeadlineMs - safetyMarginMs, deadlineAt.getTime() - clock.now().getTime() - safetyMarginMs);
    const monotonicDeadlineAt = performance.now() + remainingMs;
    let timer;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        controller.abort(new ReceiptDeadlineError());
    }
    else {
        timer = setTimeout(() => controller.abort(new ReceiptDeadlineError()), remainingMs);
    }
    const assertActive = () => {
        if (!Number.isFinite(deadlineAt.getTime()) ||
            deadlineAt.getTime() - clock.now().getTime() <= safetyMarginMs ||
            performance.now() >= monotonicDeadlineAt) {
            controller.abort(new ReceiptDeadlineError());
        }
        if (controller.signal.aborted)
            throw deadlineError(controller.signal);
    };
    return {
        signal: controller.signal,
        assertActive,
        run(operation) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (callback) => {
                    if (settled)
                        return;
                    settled = true;
                    controller.signal.removeEventListener("abort", onAbort);
                    callback();
                };
                const onAbort = () => finish(() => reject(deadlineError(controller.signal)));
                controller.signal.addEventListener("abort", onAbort, { once: true });
                void Promise.resolve().then(() => {
                    assertActive();
                    return operation(controller.signal);
                }).then((value) => {
                    try {
                        assertActive();
                        finish(() => resolve(value));
                    }
                    catch (error) {
                        finish(() => reject(error));
                    }
                }, (error) => {
                    try {
                        assertActive();
                        finish(() => reject(error));
                    }
                    catch (deadlineFailure) {
                        finish(() => reject(deadlineFailure));
                    }
                });
            });
        },
        dispose() {
            if (timer !== undefined)
                clearTimeout(timer);
        },
    };
}
function cancelReader(reader, reason) {
    try {
        void reader.cancel(reason).catch(() => undefined);
    }
    catch {
        // Cancellation is best-effort; the HTTP response must not wait for it.
    }
}
async function readReceiptBody(request, maximum, signal) {
    if (contentLengthExceeds(request, maximum))
        throw new ReceiptHttpError(413);
    if (request.body === null)
        throw new ReceiptHttpError(400);
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    const cancel = () => cancelReader(reader, signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    try {
        if (signal.aborted) {
            cancel();
            throw deadlineError(signal);
        }
        while (true) {
            const { done, value } = await reader.read();
            if (signal.aborted)
                throw deadlineError(signal);
            if (done)
                break;
            total += value.byteLength;
            if (total > maximum) {
                cancelReader(reader);
                throw new ReceiptHttpError(413);
            }
            chunks.push(value);
        }
    }
    finally {
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
    }
    catch {
        throw new ReceiptHttpError(400);
    }
}
class ReceiptHttpError extends Error {
    status;
    constructor(status) {
        super("invalid callback request");
        this.status = status;
    }
}
function serviceFailure(error) {
    if (error instanceof ReceiptDeadlineError)
        return callbackResponse(503, "callback temporarily unavailable", true);
    if (error instanceof SmsKitError && error.retryable)
        return callbackResponse(503, "callback temporarily unavailable", true);
    if (error instanceof SmsKitError && error.code === "CONFIG_INVALID")
        return callbackResponse(400, "invalid callback request");
    if (error instanceof SmsKitError && error.code === "PERMISSION_DENIED")
        return callbackResponse(401, "invalid callback token");
    return callbackResponse(500, "callback failed");
}
/**
 * Creates the public Alibaba callback boundary. The path token is checked
 * before a body stream is acquired; no callback field can select a tenant.
 */
export function createAliyunReceiptHandler(options) {
    const maximum = options.maxBodyBytes ?? ALIYUN_RECEIPT_MAX_BODY_BYTES;
    const safetyMarginMs = options.safetyMarginMs ?? callbackSafetyMarginMs;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > ALIYUN_RECEIPT_MAX_BODY_BYTES) {
        throw new RangeError("receipt maxBodyBytes must be between 1 and the Aliyun callback limit");
    }
    if (!Number.isFinite(safetyMarginMs) || safetyMarginMs < 0 || safetyMarginMs >= callbackDeadlineMs) {
        throw new RangeError("receipt safetyMarginMs must be non-negative and below the callback deadline");
    }
    return async (request) => {
        const receivedAt = options.clock.now();
        const token = pathToken(request);
        if (token === undefined)
            return callbackResponse(401, "invalid callback token");
        const deadlineAt = new Date(receivedAt.getTime() + callbackDeadlineMs);
        const deadline = createReceiptDeadline(options.clock, deadlineAt, safetyMarginMs);
        try {
            try {
                if (!(await deadline.run(() => options.verifyToken(token))))
                    return callbackResponse(401, "invalid callback token");
            }
            catch (error) {
                if (error instanceof ReceiptDeadlineError)
                    throw error;
                return callbackResponse(401, "invalid callback token");
            }
            if (request.method === "GET") {
                if (new URL(request.url).search.length !== 0 || request.headers.has("content-type") || declaredBodyIsNonempty(request)) {
                    return callbackResponse(400, "invalid callback request");
                }
                deadline.assertActive();
                return callbackResponse(200);
            }
            if (request.method !== "POST")
                return callbackResponse(405, "invalid callback request");
            if (new URL(request.url).search.length !== 0 || !isJsonContentType(request))
                return callbackResponse(400, "invalid callback request");
            const body = await deadline.run((signal) => readReceiptBody(request, maximum, signal));
            await deadline.run((signal) => options.receiptService.ingest({ token, body, deadlineAt, signal }));
            deadline.assertActive();
            return callbackResponse(200);
        }
        catch (error) {
            if (error instanceof ReceiptHttpError)
                return callbackResponse(error.status, "invalid callback request");
            return serviceFailure(error);
        }
        finally {
            deadline.dispose();
        }
    };
}
