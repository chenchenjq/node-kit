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
    const results = await Promise.all([
      client.query(`delete from sms_kit.otp_challenge where id in (select id from sms_kit.otp_challenge where created_at < $1 order by created_at limit $2)`, [input.challengeBefore, batch]),
      client.query(`delete from sms_kit.resource_sync_candidate where id in (select id from sms_kit.resource_sync_candidate where expires_at < $1 order by expires_at limit $2)`, [input.now, batch]),
      client.query(`delete from sms_kit.rate_limit_bucket where ctid in (select ctid from sms_kit.rate_limit_bucket where expires_at < $1 order by expires_at limit $2)`, [input.now, batch]),
      client.query(`delete from sms_kit.send_budget_reservation reservation using sms_kit.send_message message where reservation.message_id = message.id
        and reservation.held_at < $1 and (reservation.state = 'released' or message.acceptance_status in ('accepted','rejected','unknown') or message.delivery_status = 'unknown_final')`, [input.reservationBefore]),
      client.query(`update sms_kit.send_message set phone_ciphertext = null, phone_key_id = null, phone_hash = null, phone_last4 = null, phone_masked = null, metadata = '{}'::jsonb, version = version + 1, updated_at = now()
        where id in (select id from sms_kit.send_message where submitted_at < $1 and (phone_ciphertext is not null or phone_key_id is not null or phone_hash is not null or phone_last4 is not null or phone_masked is not null or metadata <> '{}'::jsonb)
          order by submitted_at limit $2)`, [input.messagePhoneBefore, batch]),
      client.query(`update sms_kit.delivery_receipt set redacted_payload = null, provider_message = null
        where id in (select id from sms_kit.delivery_receipt where received_at < $1 and (redacted_payload is not null or provider_message is not null) order by received_at limit $2)`, [input.receiptBefore, batch]),
      client.query(`delete from sms_kit.audit_event where id in (select id from sms_kit.audit_event where occurred_at < $1 order by occurred_at limit $2)`, [input.auditBefore, batch]),
    ]);
    return results.reduce((total, result) => total + (result.rowCount ?? 0), 0);
  }
}
