import type { Pool } from "pg";
import type { RateLimitRepository, SmsTransaction } from "../../ports/store.js";
export declare class PgRateLimitRepository implements RateLimitRepository {
    private readonly pool;
    constructor(pool: Pool);
    increment(input: Parameters<RateLimitRepository["increment"]>[0], tx?: SmsTransaction): Promise<number>;
    lock(input: Parameters<RateLimitRepository["lock"]>[0], tx: SmsTransaction): Promise<void>;
    countSince(input: Parameters<RateLimitRepository["countSince"]>[0], tx?: SmsTransaction): Promise<number>;
}
