import type { Pool, PoolClient } from "pg";

import type { DailyStats, SmsTransaction, StatsRepository } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
type StatRow = {
  tenant_id: string; stat_date: string; template_key: string; purpose: string;
  submitted_count: string; accepted_count: string; acceptance_rejected_count: string; acceptance_unknown_count: string;
  delivery_waiting_count: string; delivered_count: string; delivery_failed_count: string;
  delivery_unknown_final_count: string; retry_count: string;
};

function db(pool: Pool, tx?: SmsTransaction): Queryable { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
async function transaction<T>(pool: Pool, tx: SmsTransaction | undefined, work: (client: Queryable) => Promise<T>): Promise<T> {
  if (tx !== undefined) return work(db(pool, tx));
  const client = await pool.connect();
  try { await client.query("begin"); const result = await work(client); await client.query("commit"); return result; }
  catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}
function stats(row: StatRow): DailyStats {
  return {
    tenantId: row.tenant_id as DailyStats["tenantId"], statDate: row.stat_date, templateKey: row.template_key, purpose: row.purpose,
    submittedCount: Number(row.submitted_count), acceptedCount: Number(row.accepted_count), acceptanceRejectedCount: Number(row.acceptance_rejected_count),
    acceptanceUnknownCount: Number(row.acceptance_unknown_count), deliveryWaitingCount: Number(row.delivery_waiting_count), deliveredCount: Number(row.delivered_count),
    deliveryFailedCount: Number(row.delivery_failed_count), deliveryUnknownFinalCount: Number(row.delivery_unknown_final_count), retryCount: Number(row.retry_count),
  };
}

/** Marks the submitted UTC date of a tenant-owned message for absolute recomputation. */
export async function markMessageStatsDirty(client: Queryable, tenantId: string, messageId: string): Promise<void> {
  await client.query(
    `insert into sms_kit.stat_dirty_date (tenant_id, stat_date, version, updated_at)
     select tenant_id, submitted_at::date, 1, now()
       from sms_kit.send_message
      where tenant_id = $1 and id = $2
     on conflict (tenant_id, stat_date)
     do update set version = sms_kit.stat_dirty_date.version + 1, updated_at = now()`,
    [tenantId, messageId],
  );
}

export class PgStatsRepository implements StatsRepository {
  constructor(private readonly pool: Pool) {}

  async query(input: Parameters<StatsRepository["query"]>[0], tx?: SmsTransaction): Promise<readonly DailyStats[]> {
    const { rows } = await db(this.pool, tx).query<StatRow>(
      `select tenant_id, stat_date::text, template_key, purpose, submitted_count::text, accepted_count::text,
              acceptance_rejected_count::text, acceptance_unknown_count::text, delivery_waiting_count::text,
              delivered_count::text, delivery_failed_count::text, delivery_unknown_final_count::text, retry_count::text
         from sms_kit.daily_stat
        where tenant_id = $1 and stat_date >= $2::date and stat_date < $3::date
        order by stat_date, template_key, purpose`,
      [input.tenantId, input.from.toISOString().slice(0, 10), input.to.toISOString().slice(0, 10)],
    );
    return rows.map(stats);
  }

  async rollupDirtyDates(input: Parameters<StatsRepository["rollupDirtyDates"]>[0], tx?: SmsTransaction): Promise<number> {
    return transaction(this.pool, tx, async (client) => {
      const dirty = await client.query<{ stat_date: string; version: string }>(
        `select stat_date::text, version::text
           from sms_kit.stat_dirty_date
          where tenant_id = $1
          order by stat_date
          limit $2
          for update skip locked`,
        [input.tenantId, input.limit],
      );
      for (const date of dirty.rows) {
        await client.query("delete from sms_kit.daily_stat where tenant_id = $1 and stat_date = $2::date", [input.tenantId, date.stat_date]);
        await client.query(
          `insert into sms_kit.daily_stat (
             tenant_id, stat_date, template_id, template_key, purpose,
             submitted_count, accepted_count, acceptance_rejected_count, acceptance_unknown_count,
             delivery_waiting_count, delivered_count, delivery_failed_count, delivery_unknown_final_count,
             retry_count, updated_at
           )
           select m.tenant_id, m.submitted_at::date, max(m.template_id::text)::uuid, m.template_key_snapshot, m.purpose,
                  count(*)::bigint,
                  count(*) filter (where m.acceptance_status = 'accepted')::bigint,
                  count(*) filter (where m.acceptance_status = 'rejected')::bigint,
                  count(*) filter (where m.acceptance_status = 'unknown')::bigint,
                  count(*) filter (where m.delivery_status = 'waiting')::bigint,
                  count(*) filter (where m.delivery_status = 'delivered')::bigint,
                  count(*) filter (where m.delivery_status = 'failed')::bigint,
                  count(*) filter (where m.delivery_status = 'unknown_final')::bigint,
                  coalesce(sum((select greatest(count(*) - 1, 0) from sms_kit.send_attempt a where a.message_id = m.id)), 0)::bigint,
                  now()
             from sms_kit.send_message m
            where m.tenant_id = $1 and m.submitted_at::date = $2::date
            group by m.tenant_id, m.submitted_at::date, m.template_key_snapshot, m.purpose`,
          [input.tenantId, date.stat_date],
        );
        await client.query(
          "delete from sms_kit.stat_dirty_date where tenant_id = $1 and stat_date = $2::date and version = $3::bigint",
          [input.tenantId, date.stat_date, date.version],
        );
      }
      return dirty.rows.length;
    });
  }
}
