import type { Pool, PoolClient } from "pg";

import type { RateLimitRepository, SmsTransaction } from "../../ports/store.js";
import { scopeTenantId } from "../../core/types.js";
import type { PgSmsTransaction } from "../transaction.js";

function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient {
  return tx === undefined ? pool : (tx as PgSmsTransaction).client;
}

export class PgRateLimitRepository implements RateLimitRepository {
  constructor(private readonly pool: Pool) {}

  async increment(input: Parameters<RateLimitRepository["increment"]>[0], tx?: SmsTransaction): Promise<number> {
    const { rows } = await db(this.pool, tx).query<{ count: number }>(
      `insert into sms_kit.rate_limit_bucket (scope_type, tenant_id, scope, scope_hash, window_start, window_seconds, count, expires_at)
       values ($1, $2, $3, $4, $5, $6, 1, $7)
       on conflict (scope_type, (coalesce(tenant_id, '')), scope, scope_hash, window_start, window_seconds)
       do update set count = sms_kit.rate_limit_bucket.count + 1
       returning count`,
      [input.ownership.scopeType, scopeTenantId(input.ownership), input.scope, input.scopeHash, input.windowStart, input.windowSeconds, input.expiresAt],
    );
    return rows[0]!.count;
  }

  async lock(input: Parameters<RateLimitRepository["lock"]>[0], tx: SmsTransaction): Promise<void> {
    await db(this.pool, tx).query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`sms-kit:rate:${input.ownership.scopeType}:${scopeTenantId(input.ownership) ?? ""}:${input.scopeHash}`]);
  }

  async countSince(input: Parameters<RateLimitRepository["countSince"]>[0], tx?: SmsTransaction): Promise<number> {
    const { rows } = await db(this.pool, tx).query<{ count: string }>(
      `select coalesce(sum(count), 0)::text as count from sms_kit.rate_limit_bucket
        where scope_type = $1 and tenant_id is not distinct from $2 and scope = $3 and scope_hash = $4 and window_start > $5`,
      [input.ownership.scopeType, scopeTenantId(input.ownership), input.scope, input.scopeHash, input.since],
    );
    return Number(rows[0]?.count ?? "0");
  }
}
