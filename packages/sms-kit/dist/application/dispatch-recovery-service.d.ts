import type { Clock } from "../ports/runtime.js";
import type { SmsStore } from "../ports/store.js";
import type { SystemAuthRepository } from "../ports/system-auth.js";
export type DispatchRecoveryServiceDependencies = Readonly<{
    store: SmsStore;
    clock: Clock;
    systemAuth?: SystemAuthRepository;
}>;
export type DispatchRecoveryRunInput = Readonly<{
    limit: number;
    abandonedBefore: Date;
}>;
/** Converts abandoned dispatch markers to acceptance-unknown without ever resending. */
export declare class DispatchRecoveryService {
    private readonly dependencies;
    constructor(dependencies: DispatchRecoveryServiceDependencies);
    runBatch(input: DispatchRecoveryRunInput): Promise<number>;
}
