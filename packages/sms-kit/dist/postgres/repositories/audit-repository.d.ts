import type { Pool } from "pg";
import type { AuditEvent, AuditRepository, SmsTransaction } from "../../ports/store.js";
export declare class PgAuditRepository implements AuditRepository {
    private readonly pool;
    constructor(pool: Pool);
    append(input: AuditEvent, tx?: SmsTransaction): Promise<AuditEvent>;
    list(input: Parameters<AuditRepository["list"]>[0], tx?: SmsTransaction): Promise<{
        items: readonly AuditEvent[];
        total: number;
    }>;
}
