import { type SmsErrorCode } from "../core/errors.js";
import type { TenantId } from "../core/types.js";
import type { ProviderConfig, SmsStore, StatisticCount } from "../ports/store.js";
import type { Clock } from "../ports/runtime.js";
export type SmsHealthSnapshot = Readonly<{
    tenantId: TenantId;
    status: "ready" | "degraded" | "disabled" | "unconfigured";
    providerStatus: ProviderConfig["status"];
    lastConnectionTestAt?: Date;
    lastReceiptAt?: Date;
    pendingJobs: StatisticCount;
    acceptanceUnknown: StatisticCount;
    finalUnknown: StatisticCount;
    unmatchedReceipts: StatisticCount;
    systemBudgetRemaining: StatisticCount | null;
    circuitOpen: boolean;
    warnings: readonly SmsErrorCode[];
}>;
export type HealthServiceDependencies = Readonly<{
    store: SmsStore;
    clock?: Clock;
    receiptStaleMs?: number;
    backlogStaleMs?: number;
}>;
/** A bounded diagnostic projection: operational rows remain tenant-scoped. */
export declare class HealthService {
    private readonly dependencies;
    constructor(dependencies: HealthServiceDependencies);
    getSnapshot(input: Readonly<{
        tenantId: TenantId;
    }>): Promise<SmsHealthSnapshot>;
}
