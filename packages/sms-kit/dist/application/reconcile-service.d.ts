import type { SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink } from "../ports/runtime.js";
import type { PhoneNumberProtector } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";
export type ReconcileServiceDependencies = Readonly<{
    store: SmsStore;
    provider: SmsProvider;
    phoneProtector: Pick<PhoneNumberProtector, "unprotect">;
    clock: Clock;
    events: EventSink;
    leaseMs?: number;
    workerId?: string;
    maxPagesPerMessage?: number;
}>;
export type ReconcileRunInput = Readonly<{
    limit: number;
}>;
/** Queries a previously uncertain dispatch only; it never calls the send endpoint. */
export declare class ReconcileService {
    private readonly dependencies;
    private readonly leaseMs;
    private readonly workerId;
    private readonly maxPagesPerMessage;
    constructor(dependencies: ReconcileServiceDependencies);
    runBatch(input: ReconcileRunInput): Promise<number>;
    private reconcile;
    private recordResult;
    private finalizeUnknown;
    private reschedule;
}
