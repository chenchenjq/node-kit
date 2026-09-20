import type { ErrorCode, ErrorInfo } from "../types.js";
export declare class OssKitError extends Error implements ErrorInfo {
    readonly code: ErrorCode;
    readonly ossCode?: string;
    readonly requestId?: string;
    constructor(code: ErrorCode, details?: {
        ossCode?: string;
        requestId?: string;
    });
    toJSON(): ErrorInfo;
}
export declare function errorInfo(error: unknown): ErrorInfo;
