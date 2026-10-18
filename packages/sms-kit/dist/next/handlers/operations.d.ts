import type { HealthService } from "../../application/health-service.js";
import type { PolicyService } from "../../application/policy-service.js";
import type { ReconcileAdminService } from "../../application/reconcile-admin-service.js";
import type { Clock } from "../../ports/runtime.js";
import type { AuthorizationActor, PhoneLookupHasher } from "../../ports/security.js";
import type { SmsStore } from "../../ports/store.js";
import { type BetterAuthVerificationDto } from "../types/index.js";
type OperationsStore = Pick<SmsStore, "messages" | "attempts" | "receipts" | "stats" | "jobs" | "adminOperations">;
export type BetterAuthVerificationSettingsSource<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
    /** Must return the host's actual adapter construction snapshot, never inferred template names. */
    get(actor: Actor): BetterAuthVerificationDto | Promise<BetterAuthVerificationDto>;
}>;
/** Services consumed by Task 4 routes; all stateful behavior stays in sms-kit. */
export type SmsOperationsRouteServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
    policy?: Pick<PolicyService<Actor>, "get" | "patch">;
    health?: Pick<HealthService, "getSnapshot">;
    reconcile?: Pick<ReconcileAdminService<Actor>, "enqueue">;
    store?: OperationsStore;
    /** Read-only keyed phone lookup dependency; it never creates ciphertext. */
    phoneProtector?: Pick<PhoneLookupHasher, "lookupHash">;
    /** Read-only host-owned Better Auth integration state. */
    betterAuth?: BetterAuthVerificationSettingsSource<Actor>;
    clock?: Clock;
}>;
export type OperationJobAuthorization = Readonly<{
    requiredPermission: "sms.test" | "receipt.reconcile";
}>;
/**
 * Deferred job authorization is intentionally only a tenant-scoped metadata
 * lookup. It never returns a DTO, runs jobs, or reveals unowned worker jobs.
 */
export declare function operationJobAuthorization(services: SmsOperationsRouteServices, input: Readonly<{
    tenantId: AuthorizationActor["tenantId"];
    jobId: string;
}>): Promise<OperationJobAuthorization | undefined>;
/** Implements strict, tenant-scoped operational routes after router validation. */
export declare function operationsRoute<Actor extends AuthorizationActor>(services: SmsOperationsRouteServices<Actor>, actor: Actor, path: string, body: unknown, params: Readonly<Record<string, string>>, query: Readonly<Record<string, unknown>>): Promise<unknown | undefined>;
export {};
