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
}
