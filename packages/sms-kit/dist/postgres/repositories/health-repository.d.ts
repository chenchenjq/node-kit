import type { Pool } from "pg";
import type { HealthCounts, HealthRepository, SmsTransaction } from "../../ports/store.js";
export declare class PgHealthRepository implements HealthRepository {
    private readonly pool;
    constructor(pool: Pool);
    snapshot(input: Parameters<HealthRepository["snapshot"]>[0], tx?: SmsTransaction): Promise<HealthCounts>;
}
