import { ZodError } from "zod";
import { SmsKitError } from "../core/errors.js";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export class HttpError extends Error {
    status;
    code;
    retryable;
    fieldErrors;
    constructor(status, message, code = "CONFIG_INVALID", retryable = false, fieldErrors) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryable = retryable;
        this.fieldErrors = fieldErrors;
        this.name = "HttpError";
    }
}
function statusFor(error) {
    switch (error.code) {
        case "PERMISSION_DENIED": return 403;
        case "RATE_LIMITED":
        case "BUDGET_EXCEEDED":
        case "CIRCUIT_OPEN": return 429;
        case "IDEMPOTENCY_CONFLICT":
        case "CONCURRENT_MODIFICATION": return 409;
        case "SECRET_UNRESOLVABLE":
        case "PROVIDER_THROTTLED":
        case "PROVIDER_UNAVAILABLE": return 503;
        case "STORAGE_FAILURE": return 500;
        default: return 400;
    }
}
function safeMessageFor(code) {
    switch (code) {
        case "CONFIG_INVALID": return "invalid request";
        case "SECRET_UNRESOLVABLE": return "configuration is unavailable";
        case "PERMISSION_DENIED": return "permission denied";
        case "SIGNATURE_UNAVAILABLE":
        case "TEMPLATE_UNAVAILABLE": return "requested resource is unavailable";
        case "TEMPLATE_VARIABLE_INVALID": return "invalid template variables";
        case "RATE_LIMITED": return "rate limit exceeded";
        case "BUDGET_EXCEEDED": return "daily budget exceeded";
        case "CIRCUIT_OPEN": return "sending is temporarily disabled";
        case "PROVIDER_REJECTED": return "provider rejected the request";
        case "PROVIDER_THROTTLED": return "provider is temporarily unavailable";
        case "PROVIDER_UNAVAILABLE": return "provider is unavailable";
        case "IDEMPOTENCY_CONFLICT": return "idempotency conflict";
        case "CONCURRENT_MODIFICATION": return "concurrent modification";
        case "CHALLENGE_EXPIRED": return "challenge expired";
        case "CHALLENGE_ATTEMPTS_EXCEEDED": return "challenge attempts exceeded";
        case "CHALLENGE_SUPERSEDED": return "challenge has been superseded";
        case "PROOF_INVALID": return "proof is invalid";
        case "ACCEPTANCE_UNKNOWN": return "acceptance is unknown";
        case "DELIVERY_UNKNOWN": return "delivery is unknown";
        case "STORAGE_FAILURE": return "request failed";
    }
}
function zodFieldErrors(error) {
    const fieldErrors = {};
    for (const issue of error.issues) {
        const field = issue.path.length === 0 ? "body" : issue.path.map(String).join(".");
        (fieldErrors[field] ??= []).push(issue.message);
    }
    return Object.keys(fieldErrors).length === 0 ? undefined : fieldErrors;
}
function errorEnvelope(code, message, retryable, requestId, fieldErrors) {
    return {
        error: {
            code,
            message,
            ...(fieldErrors === undefined ? {} : { fieldErrors }),
            retryable,
        },
        requestId,
    };
}
/** Creates the stable successful response envelope used by all admin handlers. */
export function success(data, requestId, status = 200) {
    return Response.json({ data, requestId }, { status });
}
/**
 * Converts known failures to safe public envelopes. Unknown errors intentionally
 * lose their message and cause, because storage/provider errors can contain secrets.
 */
export function failure(error, requestId) {
    if (error instanceof HttpError) {
        return Response.json(errorEnvelope(error.code, error.message, error.retryable, requestId, error.fieldErrors), { status: error.status });
    }
    if (error instanceof ZodError) {
        return Response.json(errorEnvelope("CONFIG_INVALID", "invalid request", false, requestId, zodFieldErrors(error)), { status: 400 });
    }
    if (error instanceof SmsKitError) {
        return Response.json(errorEnvelope(error.code, safeMessageFor(error.code), error.retryable, requestId), { status: statusFor(error) });
    }
    return Response.json(errorEnvelope("STORAGE_FAILURE", "request failed", false, requestId), { status: 500 });
}
function declaredLengthExceedsLimit(request, maxBodyBytes) {
    const contentLength = request.headers.get("content-length");
    if (contentLength === null || !/^[0-9]+$/.test(contentLength))
        return false;
    return BigInt(contentLength) > BigInt(maxBodyBytes);
}
/** Reads a Request stream incrementally, retaining at most maxBodyBytes before JSON parsing. */
export async function parseJsonBody(request, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
        throw new TypeError("maxBodyBytes must be a positive safe integer");
    }
    if (declaredLengthExceedsLimit(request, maxBodyBytes)) {
        throw new HttpError(413, "request body is too large");
    }
    if (request.body === null)
        throw new HttpError(400, "invalid JSON body");
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.byteLength;
            if (total > maxBodyBytes) {
                await reader.cancel();
                throw new HttpError(413, "request body is too large");
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch {
        throw new HttpError(400, "invalid JSON body");
    }
}
