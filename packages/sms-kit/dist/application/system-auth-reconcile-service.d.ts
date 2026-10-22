import type { SmsProvider } from "../ports/provider.js";
import type { Clock } from "../ports/runtime.js";
import type { PhoneNumberProtector } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";
import type { SystemAuthRepository } from "../ports/system-auth.js";
export type SystemAuthReconcileServiceDependencies = Readonly<{
    store: Pick<SmsStore, "transaction" | "config">;
    repository: SystemAuthRepository;
    provider: Pick<SmsProvider, "queryDelivery">;
    phoneProtector: Pick<PhoneNumberProtector, "unprotect">;
    clock: Clock;
}>;
/** Queries SYSTEM messages after acceptance; it never calls the send endpoint. */
export declare class SystemAuthReconcileService {
    private readonly dependencies;
    constructor(dependencies: SystemAuthReconcileServiceDependencies);
    runBatch(input: Readonly<{
        limit: number;
    }>): Promise<number>;
    private reconcile;
    private reschedule;
}
