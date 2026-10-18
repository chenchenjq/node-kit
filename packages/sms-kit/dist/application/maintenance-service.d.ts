import type { Clock } from "../ports/runtime.js";
import type { SmsStore } from "../ports/store.js";
export type MaintenanceServiceDependencies = Readonly<{
    store: SmsStore;
    clock: Clock;
}>;
export type RollupDirtyDatesInput = Readonly<{
    limit: number;
}>;
export type ApplyRetentionInput = Readonly<{
    batchSize: number;
}>;
/** Performs bounded, idempotent maintenance without deleting anonymous statistics. */
export declare class MaintenanceService {
    private readonly dependencies;
    constructor(dependencies: MaintenanceServiceDependencies);
    rollupDirtyDates(input: RollupDirtyDatesInput): Promise<number>;
    applyRetention(input: ApplyRetentionInput): Promise<number>;
}
