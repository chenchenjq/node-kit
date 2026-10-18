import { scopeTenantId } from "../../core/types.js";
function db(pool, tx) {
    return tx === undefined ? pool : tx.client;
}
export class PgRateLimitRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async increment(input, tx) {
        const { rows } = await db(this.pool, tx).query(`insert into sms_kit.rate_limit_bucket (scope_type, tenant_id, scope, scope_hash, window_start, window_seconds, count, expires_at)
       values ($1, $2, $3, $4, $5, $6, 1, $7)
       on conflict (scope_type, (coalesce(tenant_id, '')), scope, scope_hash, window_start, window_seconds)
       do update set count = sms_kit.rate_limit_bucket.count + 1
       returning count`, [input.ownership.scopeType, scopeTenantId(input.ownership), input.scope, input.scopeHash, input.windowStart, input.windowSeconds, input.expiresAt]);
        return rows[0].count;
    }
    async lock(input, tx) {
        await db(this.pool, tx).query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`sms-kit:rate:${input.ownership.scopeType}:${scopeTenantId(input.ownership) ?? ""}:${input.scopeHash}`]);
    }
    async countSince(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select coalesce(sum(count), 0)::text as count from sms_kit.rate_limit_bucket
        where scope_type = $1 and tenant_id is not distinct from $2 and scope = $3 and scope_hash = $4 and window_start > $5`, [input.ownership.scopeType, scopeTenantId(input.ownership), input.scope, input.scopeHash, input.since]);
        return Number(rows[0]?.count ?? "0");
    }
}
