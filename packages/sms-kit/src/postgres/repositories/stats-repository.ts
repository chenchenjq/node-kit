import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
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
/** Preserve PostgreSQL bigint counters exactly at the repository boundary. */
function count(value: string): number | string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new SmsKitError("STORAGE_FAILURE", "statistics count is invalid", true);
  }
  const parsed = BigInt(value);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}

function stats(row: StatRow): DailyStats {
  return {
    tenantId: row.tenant_id as DailyStats["tenantId"], statDate: row.stat_date, templateKey: row.template_key, purpose: row.purpose,
    submittedCount: count(row.submitted_count), acceptedCount: count(row.accepted_count), acceptanceRejectedCount: count(row.acceptance_rejected_count),
    acceptanceUnknownCount: count(row.acceptance_unknown_count), deliveryWaitingCount: count(row.delivery_waiting_count), deliveredCount: count(row.delivered_count),
    deliveryFailedCount: count(row.delivery_failed_count), deliveryUnknownFinalCount: count(row.delivery_unknown_final_count), retryCount: count(row.retry_count),
  };
}

/** Marks the submitted UTC date of a tenant-owned message for absolute recomputation. */
export async function markMessageStatsDirty(client: Queryable, tenantId: string, messageId: string): Promise<void> {
  await client.query(
    `insert into sms_kit.stat_dirty_date (tenant_id, stat_date, version, updated_at)
     select tenant_id, (submitted_at at time zone 'UTC')::date, 1, now()
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
    const client = db(this.pool, tx);
    if (input.acceptanceStatus !== undefined || input.deliveryStatus !== undefined) {
      return this.queryMessageStatusStats(client, input);
    }

    const where = ["tenant_id = $1", "stat_date >= $2::date", "stat_date < $3::date"];
    const values: unknown[] = [input.tenantId, input.from.toISOString().slice(0, 10), input.to.toISOString().slice(0, 10)];
    const add = (column: string, value: unknown) => { values.push(value); where.push(`${column} = $${values.length}`); };
    if (input.templateKey !== undefined) add("template_key", input.templateKey);
    if (input.purpose !== undefined) add("purpose", input.purpose);
    const { rows } = await client.query<StatRow>(
      `select tenant_id, stat_date::text, template_key, purpose, submitted_count::text, accepted_count::text,
              acceptance_rejected_count::text, acceptance_unknown_count::text, delivery_waiting_count::text,
              delivered_count::text, delivery_failed_count::text, delivery_unknown_final_count::text, retry_count::text
         from sms_kit.daily_stat
        where ${where.join(" and ")}
        order by stat_date, template_key, purpose`,
      values,
    );
    return rows.map(stats);
  }

  /**
   * A daily aggregate only retains marginal status totals. When callers ask
   * for an acceptance/delivery pair, aggregate source messages so the result
   * represents their intersection rather than an ambiguous pair of margins.
   */
  private async queryMessageStatusStats(
    client: Queryable,
    input: Parameters<StatsRepository["query"]>[0],
  ): Promise<readonly DailyStats[]> {
    const where = ["m.tenant_id = $1", "m.submitted_at >= $2", "m.submitted_at < $3"];
    const values: unknown[] = [input.tenantId, input.from, input.to];
    const add = (column: string, value: unknown) => { values.push(value); where.push(`${column} = $${values.length}`); };
    if (input.templateKey !== undefined) add("m.template_key_snapshot", input.templateKey);
    if (input.purpose !== undefined) add("m.purpose", input.purpose);
    if (input.acceptanceStatus !== undefined) add("m.acceptance_status", input.acceptanceStatus);
    if (input.deliveryStatus !== undefined) add("m.delivery_status", input.deliveryStatus);
    const { rows } = await client.query<StatRow>(
      `select m.tenant_id,
              (m.submitted_at at time zone 'UTC')::date::text as stat_date,
              m.template_key_snapshot as template_key,
              m.purpose,
              count(*)::text as submitted_count,
              (count(*) filter (where m.acceptance_status = 'accepted'))::text as accepted_count,
              (count(*) filter (where m.acceptance_status = 'rejected'))::text as acceptance_rejected_count,
              (count(*) filter (where m.acceptance_status = 'unknown'))::text as acceptance_unknown_count,
              (count(*) filter (where m.delivery_status = 'waiting'))::text as delivery_waiting_count,
              (count(*) filter (where m.delivery_status = 'delivered'))::text as delivered_count,
              (count(*) filter (where m.delivery_status = 'failed'))::text as delivery_failed_count,
              (count(*) filter (where m.delivery_status = 'unknown_final'))::text as delivery_unknown_final_count,
              coalesce(sum((select greatest(count(*) - 1, 0) from sms_kit.send_attempt a where a.message_id = m.id)), 0)::text as retry_count
         from sms_kit.send_message m
        where ${where.join(" and ")}
        group by m.tenant_id, (m.submitted_at at time zone 'UTC')::date, m.template_key_snapshot, m.purpose
        order by (m.submitted_at at time zone 'UTC')::date, m.template_key_snapshot, m.purpose`,
      values,
    );
    return rows.map(stats);
  }

  async rollupDirtyDates(input: Parameters<StatsRepository["rollupDirtyDates"]>[0], tx?: SmsTransaction): Promise<number> {
    return transaction(this.pool, tx, async (client) => {
      const dirty = await client.query<{ tenant_id: string; stat_date: string; version: string }>(
        `select tenant_id, stat_date::text, version::text
           from sms_kit.stat_dirty_date
          where ($1::text is null or tenant_id = $1)
          order by tenant_id, stat_date
          limit $2
          for update skip locked`,
        [input.tenantId ?? null, input.limit],
      );
      for (const date of dirty.rows) {
        await client.query("delete from sms_kit.daily_stat where tenant_id = $1 and stat_date = $2::date", [date.tenant_id, date.stat_date]);
        await client.query(
          `insert into sms_kit.daily_stat (
             tenant_id, stat_date, template_id, template_key, purpose,
             submitted_count, accepted_count, acceptance_rejected_count, acceptance_unknown_count,
             delivery_waiting_count, delivered_count, delivery_failed_count, delivery_unknown_final_count,
             retry_count, updated_at
           )
           select m.tenant_id, (m.submitted_at at time zone 'UTC')::date, max(m.template_id::text)::uuid, m.template_key_snapshot, m.purpose,
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
            where m.tenant_id = $1 and (m.submitted_at at time zone 'UTC')::date = $2::date
            group by m.tenant_id, (m.submitted_at at time zone 'UTC')::date, m.template_key_snapshot, m.purpose`,
          [date.tenant_id, date.stat_date],
        );
        await client.query(
          "delete from sms_kit.stat_dirty_date where tenant_id = $1 and stat_date = $2::date and version = $3::bigint",
          [date.tenant_id, date.stat_date, date.version],
        );
      }
      return dirty.rows.length;
    });
  }
}
