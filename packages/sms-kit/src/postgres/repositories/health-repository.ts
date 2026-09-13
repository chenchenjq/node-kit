import type { Pool, PoolClient } from "pg";

import type { HealthCounts, HealthRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
function db(pool: Pool, tx?: SmsTransaction): Queryable { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }

export class PgHealthRepository implements HealthRepository {
  constructor(private readonly pool: Pool) {}

  async snapshot(input: Parameters<HealthRepository["snapshot"]>[0], tx?: SmsTransaction): Promise<HealthCounts> {
    const { rows } = await db(this.pool, tx).query<{
      pending_jobs: string; acceptance_unknown: string; final_unknown: string; unmatched_receipts: string; held_budget_count: string; last_receipt_at: Date | null;
    }>(`select
      (select count(*) from sms_kit.send_job where tenant_id = $1 and state in ('pending', 'leased', 'failed'))::text as pending_jobs,
      (select count(*) from sms_kit.send_message where tenant_id = $1 and acceptance_status = 'unknown')::text as acceptance_unknown,
      (select count(*) from sms_kit.send_message where tenant_id = $1 and delivery_status = 'unknown_final')::text as final_unknown,
      (select count(*) from sms_kit.delivery_receipt where match_status = 'unmatched')::text as unmatched_receipts,
      (select coalesce(held_count, 0) from sms_kit.daily_send_budget where budget_date = ($2 at time zone 'UTC')::date)::text as held_budget_count,
      (select max(received_at) from sms_kit.delivery_receipt where tenant_id = $1) as last_receipt_at`, [input.tenantId, input.now]);
    const row = rows[0];
    return {
      pendingJobs: Number(row?.pending_jobs ?? 0), acceptanceUnknown: Number(row?.acceptance_unknown ?? 0), finalUnknown: Number(row?.final_unknown ?? 0),
      unmatchedReceipts: Number(row?.unmatched_receipts ?? 0), heldBudgetCount: Number(row?.held_budget_count ?? 0),
      ...(row?.last_receipt_at === null || row?.last_receipt_at === undefined ? {} : { lastReceiptAt: row.last_receipt_at }),
    };
  }
}
