import { OssKitError } from "../rules/errors.js";
export { OssKitError, errorInfo } from "../rules/errors.js";
export function ossError(error) {
    if (error instanceof OssKitError)
        return error;
    const value = error && typeof error === "object" ? error : {};
    const safe = (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(s) ? s : undefined;
    const ossCode = safe(value.code), requestId = safe(value.requestId);
    return new OssKitError(value.name === "ConnectionTimeoutError" || value.name === "ResponseTimeoutError" ? "TIMEOUT" : "OSS_ERROR", { ...(ossCode ? { ossCode } : {}), ...(requestId ? { requestId } : {}) });
}
