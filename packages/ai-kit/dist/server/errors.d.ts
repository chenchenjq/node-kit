import type { ErrorCode, SafeError } from "../types.js";
export declare class AiKitError extends Error implements SafeError {
    readonly code: ErrorCode;
    constructor(code: ErrorCode);
    toJSON(): SafeError;
}
export declare function sanitizeError(error: unknown): AiKitError;
