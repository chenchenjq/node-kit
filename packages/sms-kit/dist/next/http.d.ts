import { type SmsErrorCode } from "../core/errors.js";
export declare class HttpError extends Error {
    readonly status: number;
    readonly code: SmsErrorCode;
    readonly retryable: boolean;
    readonly fieldErrors?: Readonly<Record<string, readonly string[]>> | undefined;
    constructor(status: number, message: string, code?: SmsErrorCode, retryable?: boolean, fieldErrors?: Readonly<Record<string, readonly string[]>> | undefined);
}
/** Creates the stable successful response envelope used by all admin handlers. */
export declare function success<T>(data: T, requestId: string, status?: number): Response;
/**
 * Converts known failures to safe public envelopes. Unknown errors intentionally
 * lose their message and cause, because storage/provider errors can contain secrets.
 */
export declare function failure(error: unknown, requestId: string): Response;
/** Reads a Request stream incrementally, retaining at most maxBodyBytes before JSON parsing. */
export declare function parseJsonBody(request: Request, maxBodyBytes?: number): Promise<unknown>;
