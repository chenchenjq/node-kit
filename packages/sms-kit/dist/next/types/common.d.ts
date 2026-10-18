import { z } from "zod";
/** Stable public error codes. Provider-specific codes never cross this boundary. */
export declare const smsErrorCodeSchema: z.ZodEnum<{
    ACCEPTANCE_UNKNOWN: "ACCEPTANCE_UNKNOWN";
    BUDGET_EXCEEDED: "BUDGET_EXCEEDED";
    CHALLENGE_ATTEMPTS_EXCEEDED: "CHALLENGE_ATTEMPTS_EXCEEDED";
    CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED";
    CIRCUIT_OPEN: "CIRCUIT_OPEN";
    CONCURRENT_MODIFICATION: "CONCURRENT_MODIFICATION";
    CONFIG_INVALID: "CONFIG_INVALID";
    DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN";
    IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT";
    PERMISSION_DENIED: "PERMISSION_DENIED";
    PROOF_INVALID: "PROOF_INVALID";
    PROVIDER_REJECTED: "PROVIDER_REJECTED";
    PROVIDER_THROTTLED: "PROVIDER_THROTTLED";
    PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE";
    RATE_LIMITED: "RATE_LIMITED";
    SECRET_UNRESOLVABLE: "SECRET_UNRESOLVABLE";
    SIGNATURE_UNAVAILABLE: "SIGNATURE_UNAVAILABLE";
    STORAGE_FAILURE: "STORAGE_FAILURE";
    TEMPLATE_UNAVAILABLE: "TEMPLATE_UNAVAILABLE";
    TEMPLATE_VARIABLE_INVALID: "TEMPLATE_VARIABLE_INVALID";
}>;
export type SmsErrorCode = z.infer<typeof smsErrorCodeSchema>;
export declare const requestIdSchema: z.ZodString;
export declare const identifierSchema: z.ZodString;
/** IDs backed by PostgreSQL uuid columns are checked before they reach a query. */
export declare const uuidSchema: z.ZodUUID;
export declare const idempotencyKeySchema: z.ZodString;
export declare const versionSchema: z.ZodNumber;
export declare const positiveVersionSchema: z.ZodNumber;
/** Public times are normalized by the server and serialized as UTC ISO-8601. */
export declare const isoDateTimeSchema: z.ZodString;
export declare const safeCountSchema: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
export declare const apiFailureSchema: z.ZodObject<{
    error: z.ZodObject<{
        code: z.ZodEnum<{
            ACCEPTANCE_UNKNOWN: "ACCEPTANCE_UNKNOWN";
            BUDGET_EXCEEDED: "BUDGET_EXCEEDED";
            CHALLENGE_ATTEMPTS_EXCEEDED: "CHALLENGE_ATTEMPTS_EXCEEDED";
            CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED";
            CIRCUIT_OPEN: "CIRCUIT_OPEN";
            CONCURRENT_MODIFICATION: "CONCURRENT_MODIFICATION";
            CONFIG_INVALID: "CONFIG_INVALID";
            DELIVERY_UNKNOWN: "DELIVERY_UNKNOWN";
            IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT";
            PERMISSION_DENIED: "PERMISSION_DENIED";
            PROOF_INVALID: "PROOF_INVALID";
            PROVIDER_REJECTED: "PROVIDER_REJECTED";
            PROVIDER_THROTTLED: "PROVIDER_THROTTLED";
            PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE";
            RATE_LIMITED: "RATE_LIMITED";
            SECRET_UNRESOLVABLE: "SECRET_UNRESOLVABLE";
            SIGNATURE_UNAVAILABLE: "SIGNATURE_UNAVAILABLE";
            STORAGE_FAILURE: "STORAGE_FAILURE";
            TEMPLATE_UNAVAILABLE: "TEMPLATE_UNAVAILABLE";
            TEMPLATE_VARIABLE_INVALID: "TEMPLATE_VARIABLE_INVALID";
        }>;
        message: z.ZodString;
        fieldErrors: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        retryable: z.ZodBoolean;
    }, z.core.$strict>;
    requestId: z.ZodString;
}, z.core.$strict>;
export declare function apiSuccessSchema<T extends z.ZodType>(data: T): z.ZodObject<{
    data: T;
    requestId: z.ZodString;
}, z.core.$strict>;
export declare function pageSchema<T extends z.ZodType>(item: T): z.ZodObject<{
    items: z.ZodArray<T>;
    page: z.ZodNumber;
    pageSize: z.ZodNumber;
    total: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
}, z.core.$strict>;
export declare const versionedWriteSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export type ApiSuccess<T> = Readonly<{
    data: T;
    requestId: string;
}>;
export type ApiFailure = z.infer<typeof apiFailureSchema>;
export type PageDto<T> = Readonly<{
    items: T[];
    page: number;
    pageSize: number;
    total: number | string;
}>;
export type VersionedWrite = z.infer<typeof versionedWriteSchema>;
