function toImmutableFieldErrors(fieldErrors) {
    return Object.freeze(Object.fromEntries(Object.entries(fieldErrors).map(([field, messages]) => [field, Object.freeze([...messages])])));
}
export class SmsKitError extends Error {
    code;
    retryable;
    fieldErrors;
    causeCode;
    constructor(code, message, retryable = false, fieldErrors, causeCode) {
        super(message);
        this.name = "SmsKitError";
        this.code = code;
        this.retryable = retryable;
        if (fieldErrors !== undefined) {
            this.fieldErrors = toImmutableFieldErrors(fieldErrors);
        }
        if (causeCode !== undefined) {
            this.causeCode = causeCode;
        }
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.fieldErrors === undefined ? {} : { fieldErrors: this.fieldErrors }),
            ...(this.causeCode === undefined ? {} : { causeCode: this.causeCode }),
        };
    }
}
