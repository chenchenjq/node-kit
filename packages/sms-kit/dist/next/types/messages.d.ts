import { z } from "zod";
export declare const acceptanceStatusSchema: z.ZodEnum<{
    accepted: "accepted";
    pending: "pending";
    rejected: "rejected";
    unknown: "unknown";
}>;
export declare const deliveryStatusSchema: z.ZodEnum<{
    delivered: "delivered";
    failed: "failed";
    not_applicable: "not_applicable";
    unknown_final: "unknown_final";
    waiting: "waiting";
}>;
export declare const phoneDtoSchema: z.ZodObject<{
    masked: z.ZodNullable<z.ZodString>;
    last4Available: z.ZodBoolean;
}, z.core.$strict>;
export declare const messageDtoSchema: z.ZodObject<{
    id: z.ZodString;
    phone: z.ZodObject<{
        masked: z.ZodNullable<z.ZodString>;
        last4Available: z.ZodBoolean;
    }, z.core.$strict>;
    templateKey: z.ZodString;
    purpose: z.ZodString;
    acceptanceStatus: z.ZodEnum<{
        accepted: "accepted";
        pending: "pending";
        rejected: "rejected";
        unknown: "unknown";
    }>;
    deliveryStatus: z.ZodEnum<{
        delivered: "delivered";
        failed: "failed";
        not_applicable: "not_applicable";
        unknown_final: "unknown_final";
        waiting: "waiting";
    }>;
    submittedAt: z.ZodString;
    attemptCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    providerBizId: z.ZodOptional<z.ZodString>;
    finalErrorCode: z.ZodOptional<z.ZodEnum<{
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
export declare const messageDetailDtoSchema: z.ZodObject<{
    id: z.ZodString;
    phone: z.ZodObject<{
        masked: z.ZodNullable<z.ZodString>;
        last4Available: z.ZodBoolean;
    }, z.core.$strict>;
    templateKey: z.ZodString;
    purpose: z.ZodString;
    acceptanceStatus: z.ZodEnum<{
        accepted: "accepted";
        pending: "pending";
        rejected: "rejected";
        unknown: "unknown";
    }>;
    deliveryStatus: z.ZodEnum<{
        delivered: "delivered";
        failed: "failed";
        not_applicable: "not_applicable";
        unknown_final: "unknown_final";
        waiting: "waiting";
    }>;
    submittedAt: z.ZodString;
    attemptCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    providerBizId: z.ZodOptional<z.ZodString>;
    finalErrorCode: z.ZodOptional<z.ZodEnum<{
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
    version: z.ZodNumber;
    acceptedAt: z.ZodOptional<z.ZodString>;
    deliveredAt: z.ZodOptional<z.ZodString>;
    finalizedAt: z.ZodOptional<z.ZodString>;
    providerRequestId: z.ZodOptional<z.ZodString>;
    attempts: z.ZodArray<z.ZodObject<{
        attemptNo: z.ZodNumber;
        status: z.ZodEnum<{
            accepted: "accepted";
            rejected: "rejected";
            started: "started";
            unknown: "unknown";
        }>;
        dispatchMode: z.ZodEnum<{
            direct: "direct";
            queued: "queued";
        }>;
        dispatchMarkedAt: z.ZodString;
        occurredAt: z.ZodString;
        providerRequestId: z.ZodOptional<z.ZodString>;
        errorCode: z.ZodOptional<z.ZodEnum<{
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
        latencyMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    receipts: z.ZodArray<z.ZodObject<{
        source: z.ZodEnum<{
            callback: "callback";
            query: "query";
        }>;
        deliveryStatus: z.ZodEnum<{
            delivered: "delivered";
            failed: "failed";
        }>;
        occurredAt: z.ZodString;
        receivedAt: z.ZodString;
        diagnostics: z.ZodObject<{
            redactedFields: z.ZodArray<z.ZodEnum<{
                otp: "otp";
                phone: "phone";
                proof: "proof";
                secret: "secret";
                "template-params": "template-params";
            }>>;
            reportCount: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    diagnostics: z.ZodObject<{
        redactedFields: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            otp: "otp";
            phone: "phone";
            proof: "proof";
            secret: "secret";
            "template-params": "template-params";
        }>>>;
        counts: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodEnum<{
                attempt: "attempt";
                job: "job";
                message: "message";
                "rate-limit": "rate-limit";
                receipt: "receipt";
                resource: "resource";
                signature: "signature";
                template: "template";
            }>;
            value: z.ZodNumber;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const messagePageDtoSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        phone: z.ZodObject<{
            masked: z.ZodNullable<z.ZodString>;
            last4Available: z.ZodBoolean;
        }, z.core.$strict>;
        templateKey: z.ZodString;
        purpose: z.ZodString;
        acceptanceStatus: z.ZodEnum<{
            accepted: "accepted";
            pending: "pending";
            rejected: "rejected";
            unknown: "unknown";
        }>;
        deliveryStatus: z.ZodEnum<{
            delivered: "delivered";
            failed: "failed";
            not_applicable: "not_applicable";
            unknown_final: "unknown_final";
            waiting: "waiting";
        }>;
        submittedAt: z.ZodString;
        attemptCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
        providerBizId: z.ZodOptional<z.ZodString>;
        finalErrorCode: z.ZodOptional<z.ZodEnum<{
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
    }, z.core.$strict>>;
    page: z.ZodNumber;
    pageSize: z.ZodNumber;
    total: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
}, z.core.$strict>;
export declare const messageQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodNumber>;
    pageSize: z.ZodDefault<z.ZodNumber>;
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    acceptanceStatus: z.ZodOptional<z.ZodEnum<{
        accepted: "accepted";
        pending: "pending";
        rejected: "rejected";
        unknown: "unknown";
    }>>;
    deliveryStatus: z.ZodOptional<z.ZodEnum<{
        delivered: "delivered";
        failed: "failed";
        not_applicable: "not_applicable";
        unknown_final: "unknown_final";
        waiting: "waiting";
    }>>;
    templateKey: z.ZodOptional<z.ZodString>;
    purpose: z.ZodOptional<z.ZodString>;
    phone: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const receiptHealthDtoSchema: z.ZodObject<{
    status: z.ZodEnum<{
        degraded: "degraded";
        disabled: "disabled";
        ready: "ready";
        unconfigured: "unconfigured";
    }>;
    lastReceiptAt: z.ZodOptional<z.ZodString>;
    pendingJobs: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    acceptanceUnknown: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    deliveryUnknownFinal: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
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
export declare const reconcileInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    messageId: z.ZodOptional<z.ZodString>;
    providerBizId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const jobStateSchema: z.ZodEnum<{
    dead: "dead";
    failed: "failed";
    leased: "leased";
    pending: "pending";
    succeeded: "succeeded";
}>;
export declare const jobTypeSchema: z.ZodEnum<{
    dispatch_recovery: "dispatch_recovery";
    reconcile: "reconcile";
    retention: "retention";
    rollup: "rollup";
    send: "send";
}>;
export declare const jobDtoSchema: z.ZodObject<{
    id: z.ZodString;
    jobType: z.ZodEnum<{
        dispatch_recovery: "dispatch_recovery";
        reconcile: "reconcile";
        retention: "retention";
        rollup: "rollup";
        send: "send";
    }>;
    state: z.ZodEnum<{
        dead: "dead";
        failed: "failed";
        leased: "leased";
        pending: "pending";
        succeeded: "succeeded";
    }>;
    messageId: z.ZodOptional<z.ZodString>;
    availableAt: z.ZodString;
    attemptCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    maxAttempts: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    lastErrorCode: z.ZodOptional<z.ZodEnum<{
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
export declare const smsStatsDtoSchema: z.ZodObject<{
    submitted: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    accepted: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    acceptanceRejected: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    acceptanceUnknown: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    deliveryWaiting: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    delivered: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    deliveryFailed: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    deliveryUnknownFinal: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    retry: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    acceptanceRate: z.ZodOptional<z.ZodNumber>;
    deliveryRate: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const statsQuerySchema: z.ZodObject<{
    from: z.ZodOptional<z.ZodString>;
    to: z.ZodOptional<z.ZodString>;
    templateKey: z.ZodOptional<z.ZodString>;
    purpose: z.ZodOptional<z.ZodString>;
    acceptanceStatus: z.ZodOptional<z.ZodEnum<{
        accepted: "accepted";
        pending: "pending";
        rejected: "rejected";
        unknown: "unknown";
    }>>;
    deliveryStatus: z.ZodOptional<z.ZodEnum<{
        delivered: "delivered";
        failed: "failed";
        not_applicable: "not_applicable";
        unknown_final: "unknown_final";
        waiting: "waiting";
    }>>;
}, z.core.$strict>;
export type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type PhoneDto = z.infer<typeof phoneDtoSchema>;
export type MessageDto = z.infer<typeof messageDtoSchema>;
export type MessageDetailDto = z.infer<typeof messageDetailDtoSchema>;
export type MessageQuery = z.infer<typeof messageQuerySchema>;
export type ReceiptHealthDto = z.infer<typeof receiptHealthDtoSchema>;
export type ReconcileInput = z.infer<typeof reconcileInputSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobDto = z.infer<typeof jobDtoSchema>;
export type SmsStatsDto = z.infer<typeof smsStatsDtoSchema>;
export type StatsQuery = z.infer<typeof statsQuerySchema>;
