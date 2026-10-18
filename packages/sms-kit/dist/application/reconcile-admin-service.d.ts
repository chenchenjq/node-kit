import { type MessageId } from "../core/types.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { AuthorizationActor, Authorizer } from "../ports/security.js";
import type { Job, JobOriginAction, SmsStore } from "../ports/store.js";
export type EnqueueReconciliationInput = Readonly<{
    expectedVersion: number;
    idempotencyKey: string;
    messageId?: MessageId;
    providerBizId?: string;
}>;
/** The safe subset needed by an admin response and durable replay record. */
export type ReconciliationJob = Readonly<{
    id: string;
    jobType: "reconcile";
    state: Job["state"];
    messageId?: MessageId;
    availableAt: Date;
    attemptCount: number;
    maxAttempts: number;
    /** Internal source fence used only before an idempotent result is returned. */
    originAction?: JobOriginAction;
}>;
export type EnqueueReconciliationResult = Readonly<{
    kind: "scheduled";
    job: ReconciliationJob;
}> | Readonly<{
    kind: "not-found";
}>;
export type ReconcileAdminServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
    store: SmsStore;
    authorizer: Authorizer<Actor>;
    clock: Clock;
    ids: Pick<IdGenerator, "next">;
}>;
/**
 * Enqueues, rather than executes, a manual receipt reconciliation.  The
 * worker remains the only component allowed to contact the provider.
 */
export declare class ReconcileAdminService<Actor extends AuthorizationActor = AuthorizationActor> {
    private readonly dependencies;
    constructor(dependencies: ReconcileAdminServiceDependencies<Actor>);
    /**
     * A system/ordinary-message job has no originating admin authority, so a
     * tenant-scoped receipt reconciliation may safely reuse it. A job inherited
     * from an admin test send retains that stronger source permission: never let
     * a receipt-only caller learn or replay it.
     */
    private authorizeReturnedJob;
    enqueue(actor: Actor, input: EnqueueReconciliationInput): Promise<EnqueueReconciliationResult>;
}
