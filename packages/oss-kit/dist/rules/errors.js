const messages = {
    INVALID_CONFIG: "Invalid storage or runtime configuration", INVALID_STRATEGY: "Invalid usage strategy",
    INVALID_PATH: "Invalid object path", INVALID_FILE: "Invalid filename or extension",
    FILE_TOO_LARGE: "File exceeds the actual byte limit", TYPE_MISMATCH: "File content, extension and MIME do not match an allowed type",
    FORBIDDEN: "Host authorization denied this operation", NOT_FOUND: "Configuration or strategy not found",
    NO_DEFAULT_STORAGE: "No enabled default storage", STORAGE_DISABLED: "Storage is disabled",
    STRATEGY_DISABLED: "Strategy is disabled", IMMUTABLE_LOCATION: "Bucket and region are immutable; create another storage configuration",
    IMMUTABLE_ACCESS: "Used storage access mode is immutable; create another storage configuration",
    CREDENTIAL_SECURITY_REQUIRED: "A server credential protector is required", CREDENTIAL_FAILURE: "Credential protection or resolution failed",
    OSS_ERROR: "OSS operation failed", TIMEOUT: "Operation timed out", STORE_ERROR: "Host persistence operation failed",
};
export class OssKitError extends Error {
    code;
    ossCode;
    requestId;
    constructor(code, details) {
        super(messages[code]);
        this.name = "OssKitError";
        this.code = code;
        if (details?.ossCode)
            this.ossCode = details.ossCode;
        if (details?.requestId)
            this.requestId = details.requestId;
    }
    toJSON() {
        return { code: this.code, message: this.message, ...(this.ossCode ? { ossCode: this.ossCode } : {}), ...(this.requestId ? { requestId: this.requestId } : {}) };
    }
}
export function errorInfo(error) {
    return error instanceof OssKitError ? error.toJSON() : new OssKitError("OSS_ERROR").toJSON();
}
