import type { Pool } from "pg";
import type { MaintenanceRepository, SmsTransaction } from "../../ports/store.js";
/** Privacy lifecycle work is bounded per table; daily aggregate statistics are never touched. */
export declare class PgMaintenanceRepository implements MaintenanceRepository {
    private readonly pool;
    constructor(pool: Pool);
    applyRetention(input: Parameters<MaintenanceRepository["applyRetention"]>[0], tx?: SmsTransaction): Promise<number>;
}
