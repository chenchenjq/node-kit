import type { Pool, PoolClient } from "pg";

import type { MaintenanceRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
function db(pool: Pool, tx?: SmsTransaction): Queryable { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }

/** Privacy lifecycle work is bounded per table; daily aggregate statistics are never touched. */
export class PgMaintenanceRepository implements MaintenanceRepository {
  constructor(private readonly pool: Pool) {}

  async applyRetention(input: Parameters<MaintenanceRepository["applyRetention"]>[0], tx?: SmsTransaction): Promise<number> {
    const client = db(this.pool, tx);
    const batch = input.batchSize;
    const before = input.before;
    const results = await Promise.all([
      client.query(`delete from sms_kit.otp_challenge where id in (select id from sms_kit.otp_challenge where expires_at < $1 order by expires_at limit $2)`, [before, batch]),
      client.query(`delete from sms_kit.resource_sync_candidate where id in (select id from sms_kit.resource_sync_candidate where expires_at < $1 order by expires_at limit $2)`, [before, batch]),
      client.query(`delete from sms_kit.rate_limit_bucket where ctid in (select ctid from sms_kit.rate_limit_bucket where expires_at < $1 order by expires_at limit $2)`, [before, batch]),
      // Held reservations still enforce the current budget and must never be collected.
      client.query(`delete from sms_kit.send_budget_reservation where id in (select id from sms_kit.send_budget_reservation where state = 'released' and released_at < $1 order by released_at limit $2)`, [before, batch]),
      client.query(`update sms_kit.send_message set phone_ciphertext = null, phone_key_id = null, version = version + 1, updated_at = now()
        where id in (select id from sms_kit.send_message where submitted_at < $1 and phone_ciphertext is not null and phone_key_id is not null
          order by submitted_at limit $2)`, [before, batch]),
    ]);
    return results.reduce((total, result) => total + (result.rowCount ?? 0), 0);
  }
}
