import type { AuthErrorCode } from "../types.js";
export declare class AuthKitError extends Error {
    readonly code: AuthErrorCode;
    readonly status: number;
    readonly retryAt?: number | undefined;
    constructor(code: AuthErrorCode, status: number, retryAt?: number | undefined);
}
export declare function errorResponse(error: unknown, serverTime?: number): Response;
