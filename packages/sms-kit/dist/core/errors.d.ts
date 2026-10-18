export type SmsErrorCode = "CONFIG_INVALID" | "SECRET_UNRESOLVABLE" | "PERMISSION_DENIED" | "SIGNATURE_UNAVAILABLE" | "TEMPLATE_UNAVAILABLE" | "TEMPLATE_VARIABLE_INVALID" | "RATE_LIMITED" | "BUDGET_EXCEEDED" | "CIRCUIT_OPEN" | "PROVIDER_REJECTED" | "PROVIDER_THROTTLED" | "PROVIDER_UNAVAILABLE" | "IDEMPOTENCY_CONFLICT" | "CONCURRENT_MODIFICATION" | "CHALLENGE_EXPIRED" | "CHALLENGE_ATTEMPTS_EXCEEDED" | "CHALLENGE_SUPERSEDED" | "PROOF_INVALID" | "ACCEPTANCE_UNKNOWN" | "DELIVERY_UNKNOWN" | "STORAGE_FAILURE";
export type SmsFieldErrors = Readonly<Record<string, readonly string[]>>;
export declare class SmsKitError extends Error {
    readonly code: SmsErrorCode;
    readonly retryable: boolean;
    readonly fieldErrors?: SmsFieldErrors;
    readonly causeCode?: string;
    constructor(code: SmsErrorCode, message: string, retryable?: boolean, fieldErrors?: SmsFieldErrors, causeCode?: string);
    toJSON(): {
        code: SmsErrorCode;
        message: string;
        retryable: boolean;
        fieldErrors?: SmsFieldErrors;
        causeCode?: string;
    };
}
