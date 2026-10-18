import type { Pool, PoolClient } from "pg";
import type { DailyStats, SmsTransaction, StatsRepository } from "../../ports/store.js";
type Queryable = Pool | PoolClient;
/** Marks the submitted UTC date of a tenant-owned message for absolute recomputation. */
export declare function markMessageStatsDirty(client: Queryable, tenantId: string, messageId: string): Promise<void>;
export declare class PgStatsRepository implements StatsRepository {
    private readonly pool;
    constructor(pool: Pool);
    query(input: Parameters<StatsRepository["query"]>[0], tx?: SmsTransaction): Promise<readonly DailyStats[]>;
    /**
     * A daily aggregate only retains marginal status totals. When callers ask
     * for an acceptance/delivery pair, aggregate source messages so the result
     * represents their intersection rather than an ambiguous pair of margins.
     */
    private queryMessageStatusStats;
    rollupDirtyDates(input: Parameters<StatsRepository["rollupDirtyDates"]>[0], tx?: SmsTransaction): Promise<number>;
}
export {};
