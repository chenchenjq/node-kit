import { z } from "zod";
export declare const secretRefDtoSchema: z.ZodObject<{
    scheme: z.ZodString;
    maskedName: z.ZodString;
    configured: z.ZodBoolean;
}, z.core.$strict>;
export declare const providerConfigStatusSchema: z.ZodEnum<{
    degraded: "degraded";
    disabled: "disabled";
    ready: "ready";
    unconfigured: "unconfigured";
    untested: "untested";
}>;
export declare const providerConfigDtoSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    provider: z.ZodLiteral<"aliyun">;
    status: z.ZodLiteral<"unconfigured">;
    enabled: z.ZodLiteral<false>;
    lastTestStatus: z.ZodLiteral<"never">;
    version: z.ZodNumber;
}, z.core.$strict>, z.ZodObject<{
    provider: z.ZodLiteral<"aliyun">;
    status: z.ZodEnum<{
        degraded: "degraded";
        disabled: "disabled";
        ready: "ready";
        untested: "untested";
    }>;
    enabled: z.ZodBoolean;
    region: z.ZodString;
    endpoint: z.ZodOptional<z.ZodString>;
    accessKeyIdRef: z.ZodObject<{
        scheme: z.ZodString;
        maskedName: z.ZodString;
        configured: z.ZodBoolean;
    }, z.core.$strict>;
    accessKeySecretRef: z.ZodObject<{
        scheme: z.ZodString;
        maskedName: z.ZodString;
        configured: z.ZodBoolean;
    }, z.core.$strict>;
    receiptCallbackTokenRef: z.ZodObject<{
        scheme: z.ZodString;
        maskedName: z.ZodString;
        configured: z.ZodBoolean;
    }, z.core.$strict>;
    lastTestStatus: z.ZodEnum<{
        failed: "failed";
        never: "never";
        succeeded: "succeeded";
    }>;
    lastTestedAt: z.ZodOptional<z.ZodString>;
    version: z.ZodNumber;
}, z.core.$strict>], "status">;
export declare const updateProviderConfigSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    provider: z.ZodOptional<z.ZodLiteral<"aliyun">>;
    region: z.ZodString;
    endpoint: z.ZodOptional<z.ZodString>;
    accessKeyIdRef: z.ZodString;
    accessKeySecretRef: z.ZodString;
    receiptCallbackTokenRef: z.ZodOptional<z.ZodString>;
    enabled: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const connectionTestResultDtoSchema: z.ZodObject<{
    status: z.ZodEnum<{
        failed: "failed";
        succeeded: "succeeded";
    }>;
    testedAt: z.ZodString;
    signatureCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    templateCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    config: z.ZodDiscriminatedUnion<[z.ZodObject<{
        provider: z.ZodLiteral<"aliyun">;
        status: z.ZodLiteral<"unconfigured">;
        enabled: z.ZodLiteral<false>;
        lastTestStatus: z.ZodLiteral<"never">;
        version: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        provider: z.ZodLiteral<"aliyun">;
        status: z.ZodEnum<{
            degraded: "degraded";
            disabled: "disabled";
            ready: "ready";
            untested: "untested";
        }>;
        enabled: z.ZodBoolean;
        region: z.ZodString;
        endpoint: z.ZodOptional<z.ZodString>;
        accessKeyIdRef: z.ZodObject<{
            scheme: z.ZodString;
            maskedName: z.ZodString;
            configured: z.ZodBoolean;
        }, z.core.$strict>;
        accessKeySecretRef: z.ZodObject<{
            scheme: z.ZodString;
            maskedName: z.ZodString;
            configured: z.ZodBoolean;
        }, z.core.$strict>;
        receiptCallbackTokenRef: z.ZodObject<{
            scheme: z.ZodString;
            maskedName: z.ZodString;
            configured: z.ZodBoolean;
        }, z.core.$strict>;
        lastTestStatus: z.ZodEnum<{
            failed: "failed";
            never: "never";
            succeeded: "succeeded";
        }>;
        lastTestedAt: z.ZodOptional<z.ZodString>;
        version: z.ZodNumber;
    }, z.core.$strict>], "status">;
}, z.core.$strict>;
/** Connection tests write a versioned result, so retries need their own key. */
export declare const testConnectionInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const testSendInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    phone: z.ZodString;
    templateKey: z.ZodString;
    variables: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    purpose: z.ZodString;
}, z.core.$strict>;
export declare const smsOverviewDtoSchema: z.ZodObject<{
    status: z.ZodEnum<{
        degraded: "degraded";
        disabled: "disabled";
        ready: "ready";
        unconfigured: "unconfigured";
    }>;
    providerStatus: z.ZodEnum<{
        degraded: "degraded";
        disabled: "disabled";
        ready: "ready";
        unconfigured: "unconfigured";
        untested: "untested";
    }>;
    pendingJobs: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    acceptanceUnknown: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    deliveryUnknown: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    unmatchedCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    systemBudgetRemaining: z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    circuitOpen: z.ZodBoolean;
    warnings: z.ZodArray<z.ZodEnum<{
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
    }>>;
}, z.core.$strict>;
export type SecretRefDto = z.infer<typeof secretRefDtoSchema>;
export type ProviderConfigStatus = z.infer<typeof providerConfigStatusSchema>;
export type ProviderConfigDto = z.infer<typeof providerConfigDtoSchema>;
export type UpdateProviderConfigInput = z.infer<typeof updateProviderConfigSchema>;
export type ConnectionTestResultDto = z.infer<typeof connectionTestResultDtoSchema>;
export type TestConnectionInput = z.infer<typeof testConnectionInputSchema>;
export type TestSendInput = z.infer<typeof testSendInputSchema>;
export type SmsOverviewDto = z.infer<typeof smsOverviewDtoSchema>;
