import type { ConfigService } from "../../application/config-service.js";
import type { HealthService } from "../../application/health-service.js";
import type { SendService } from "../../application/send-service.js";
import type { AuthorizationActor } from "../../ports/security.js";
import type { Message, ProviderConfig } from "../../ports/store.js";
/** The narrowly scoped application services required by the configuration routes. */
export type SmsConfigRouteServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
    config?: Pick<ConfigService<Actor>, "get" | "patch" | "testConnection">;
    health?: Pick<HealthService, "getSnapshot">;
    send?: Pick<SendService, "enqueueTestNotification">;
}>;
/** Explicit allow-list projection: no raw secret reference may cross this function. */
export declare function providerConfigDto(config: ProviderConfig): {
    provider: "aliyun";
    status: "unconfigured";
    enabled: false;
    lastTestStatus: "never";
    version: number;
} | {
    provider: "aliyun";
    status: "degraded" | "disabled" | "ready" | "untested";
    enabled: boolean;
    region: string;
    endpoint?: string | undefined;
    accessKeyIdRef: {
        scheme: string;
        maskedName: string;
        configured: boolean;
    };
    accessKeySecretRef: {
        scheme: string;
        maskedName: string;
        configured: boolean;
    };
    receiptCallbackTokenRef: {
        scheme: string;
        maskedName: string;
        configured: boolean;
    };
    lastTestStatus: "failed" | "never" | "succeeded";
    lastTestedAt?: string | undefined;
    version: number;
};
/** Explicit message projection drops ciphertext, hashes, parameters, and the full phone number. */
export declare function messageDto(message: Pick<Message, "id" | "phoneMasked" | "phoneLast4" | "templateKeySnapshot" | "purpose" | "acceptanceStatus" | "deliveryStatus" | "submittedAt" | "providerBizId" | "finalErrorCode"> & Readonly<{
    attemptCount?: number | string;
}>): {
    id: string;
    phone: {
        masked: string | null;
        last4Available: boolean;
    };
    templateKey: string;
    purpose: string;
    acceptanceStatus: "accepted" | "pending" | "rejected" | "unknown";
    deliveryStatus: "delivered" | "failed" | "not_applicable" | "unknown_final" | "waiting";
    submittedAt: string;
    attemptCount: string | number;
    providerBizId?: string | undefined;
    finalErrorCode?: "ACCEPTANCE_UNKNOWN" | "BUDGET_EXCEEDED" | "CHALLENGE_ATTEMPTS_EXCEEDED" | "CHALLENGE_EXPIRED" | "CIRCUIT_OPEN" | "CONCURRENT_MODIFICATION" | "CONFIG_INVALID" | "DELIVERY_UNKNOWN" | "IDEMPOTENCY_CONFLICT" | "PERMISSION_DENIED" | "PROOF_INVALID" | "PROVIDER_REJECTED" | "PROVIDER_THROTTLED" | "PROVIDER_UNAVAILABLE" | "RATE_LIMITED" | "SECRET_UNRESOLVABLE" | "SIGNATURE_UNAVAILABLE" | "STORAGE_FAILURE" | "TEMPLATE_UNAVAILABLE" | "TEMPLATE_VARIABLE_INVALID" | undefined;
};
export declare function configurationRoute<Actor extends AuthorizationActor>(services: SmsConfigRouteServices<Actor>, actor: Actor, path: string, body: unknown): Promise<unknown | undefined>;
