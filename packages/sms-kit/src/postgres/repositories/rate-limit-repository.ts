import type { Pool, PoolClient } from "pg";

import type { RateLimitRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient {
  return tx === undefined ? pool : (tx as PgSmsTransaction).client;
}

export class PgRateLimitRepository implements RateLimitRepository {
  constructor(private readonly pool: Pool) {}

  async increment(input: Parameters<RateLimitRepository["increment"]>[0], tx?: SmsTransaction): Promise<number> {
    const { rows } = await db(this.pool, tx).query<{ count: number }>(
      `insert into sms_kit.rate_limit_bucket (tenant_id, scope, scope_hash, window_start, window_seconds, count, expires_at)
       values ($1, $2, $3, $4, $5, 1, $6)
       on conflict (tenant_id, scope, scope_hash, window_start, window_seconds)
       do update set count = sms_kit.rate_limit_bucket.count + 1
       returning count`,
      [input.tenantId, input.scope, input.scopeHash, input.windowStart, input.windowSeconds, input.expiresAt],
    );
    return rows[0]!.count;
  }

  async lock(input: Parameters<RateLimitRepository["lock"]>[0], tx: SmsTransaction): Promise<void> {
    await db(this.pool, tx).query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`sms-kit:rate:${input.tenantId}:${input.scopeHash}`]);
  }

  async countSince(input: Parameters<RateLimitRepository["countSince"]>[0], tx?: SmsTransaction): Promise<number> {
    const { rows } = await db(this.pool, tx).query<{ count: string }>(
      `select coalesce(sum(count), 0)::text as count from sms_kit.rate_limit_bucket
        where tenant_id = $1 and scope = $2 and scope_hash = $3 and window_start > $4`,
      [input.tenantId, input.scope, input.scopeHash, input.since],
    );
    return Number(rows[0]?.count ?? "0");
  }
}
