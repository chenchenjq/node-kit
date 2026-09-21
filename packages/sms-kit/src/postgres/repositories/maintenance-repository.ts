import type { Pool, PoolClient } from "pg";

import type { MaintenanceRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";
import { markMessageStatsDirty } from "./stats-repository.js";

type Queryable = Pool | PoolClient;
function db(pool: Pool, tx?: SmsTransaction): Queryable { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }

/** Privacy lifecycle work is bounded per table; daily aggregate statistics are never touched. */
export class PgMaintenanceRepository implements MaintenanceRepository {
  constructor(private readonly pool: Pool) {}

  async applyRetention(input: Parameters<MaintenanceRepository["applyRetention"]>[0], tx?: SmsTransaction): Promise<number> {
    if (tx === undefined) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        const count = await this.applyRetention(input, { client } as PgSmsTransaction);
        await client.query("commit");
        return count;
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    }
    const client = db(this.pool, tx);
    const batch = input.batchSize;
    const candidates = await client.query<{ id: string; tenant_id: string }>(`select id, tenant_id from sms_kit.send_message
      where submitted_at < $1 and (phone_ciphertext is not null or phone_key_id is not null or phone_hash is not null or phone_last4 is not null or phone_masked is not null or render_params_ciphertext is not null or render_params_key_id is not null or metadata <> '{}'::jsonb)
      order by submitted_at, id limit $2`, [input.messagePhoneBefore, batch]);
    let scrubbed = 0;
    for (const candidate of candidates.rows) {
      // Follow dispatch lock order and fence a worker that leased after selection.
      const jobs = await client.query<{ state: string; lease_until: Date | null }>("select state, lease_until from sms_kit.send_job where message_id = $1 order by id for update", [candidate.id]);
      if (jobs.rows.some((job) => job.state === "leased" && job.lease_until !== null && job.lease_until > input.now)) continue;
      await client.query("select id from sms_kit.send_message where id = $1 for update", [candidate.id]);
      const uncertain = await client.query("select id from sms_kit.send_attempt where message_id = $1 and status in ('started','accepted','unknown') for update", [candidate.id]);
      const hasDispatch = uncertain.rowCount !== 0;
      await client.query("update sms_kit.send_attempt set status = 'unknown', error_code = 'ACCEPTANCE_UNKNOWN', occurred_at = $2 where message_id = $1 and status = 'started'", [candidate.id, input.now]);
      const changed = await client.query(`update sms_kit.send_message set phone_ciphertext = null, phone_key_id = null, phone_hash = null, phone_last4 = null, phone_masked = null,
        render_params_ciphertext = null, render_params_key_id = null, metadata = '{}'::jsonb,
        acceptance_status = case when acceptance_status = 'pending' then $3 else acceptance_status end,
        delivery_status = case when delivery_status = 'waiting' or (acceptance_status = 'pending' and $3 = 'unknown') then 'unknown_final' else delivery_status end,
        finalized_at = coalesce(finalized_at, $2), version = version + 1, updated_at = now() where id = $1`, [candidate.id, input.now, hasDispatch ? "unknown" : "rejected"]);
      await client.query("update sms_kit.send_job set state = 'dead', lease_owner = null, lease_token = null, lease_until = null, last_error_code = 'STORAGE_FAILURE', updated_at = now() where message_id = $1 and state in ('pending','failed','leased')", [candidate.id]);
      await client.query(`with released as (
        update sms_kit.send_budget_reservation r set state = 'released', released_at = $2
        from sms_kit.send_message m where r.message_id = m.id and m.id = $1 and m.acceptance_status = 'rejected' and r.state = 'held'
        returning r.budget_date
      ) update sms_kit.daily_send_budget b set held_count = held_count - 1, version = version + 1, updated_at = now()
        from released where b.budget_date = released.budget_date and b.held_count > 0`, [candidate.id, input.now]);
      await markMessageStatsDirty(client, candidate.tenant_id, candidate.id);
      scrubbed += changed.rowCount ?? 0;
    }
    const results = [
      await client.query(`delete from sms_kit.otp_challenge where id in (select id from sms_kit.otp_challenge where created_at < $1 order by created_at limit $2)`, [input.challengeBefore, batch]),
      await client.query(`delete from sms_kit.resource_sync_candidate where id in (select id from sms_kit.resource_sync_candidate where expires_at < $1 order by expires_at limit $2)`, [input.now, batch]),
      await client.query(`delete from sms_kit.rate_limit_bucket where ctid in (select ctid from sms_kit.rate_limit_bucket where expires_at < $1 order by expires_at limit $2)`, [input.now, batch]),
      await client.query(`delete from sms_kit.send_budget_reservation where id in (
        select reservation.id from sms_kit.send_budget_reservation reservation
          join sms_kit.send_message message on message.id = reservation.message_id
         where reservation.held_at < $1 and (reservation.state = 'released' or message.acceptance_status in ('accepted','rejected','unknown') or message.delivery_status = 'unknown_final')
         order by reservation.held_at, reservation.id limit $2
      )`, [input.reservationBefore, batch]),
      await client.query(`update sms_kit.delivery_receipt set redacted_payload = null, provider_message = null
        where id in (select id from sms_kit.delivery_receipt where received_at < $1 and (redacted_payload is not null or provider_message is not null) order by received_at limit $2)`, [input.receiptBefore, batch]),
      await client.query(`delete from sms_kit.audit_event where id in (select id from sms_kit.audit_event where occurred_at < $1 order by occurred_at limit $2)`, [input.auditBefore, batch]),
    ];
    return scrubbed + results.reduce((total, result) => total + (result.rowCount ?? 0), 0);
  }
}
