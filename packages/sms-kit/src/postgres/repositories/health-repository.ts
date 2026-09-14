import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { HealthCounts, HealthRepository, SmsTransaction, StatisticCount } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
function db(pool: Pool, tx?: SmsTransaction): Queryable { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function count(value: string | undefined): StatisticCount {
  const raw = value ?? "0";
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new SmsKitError("STORAGE_FAILURE", "health count is invalid", true);
  }
  const parsed = BigInt(raw);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}

export class PgHealthRepository implements HealthRepository {
  constructor(private readonly pool: Pool) {}

  async snapshot(input: Parameters<HealthRepository["snapshot"]>[0], tx?: SmsTransaction): Promise<HealthCounts> {
    const { rows } = await db(this.pool, tx).query<{
      pending_jobs: string; acceptance_unknown: string; final_unknown: string; unmatched_receipts: string; held_budget_count: string; last_receipt_at: Date | null;
      usable_templates: string; waiting_messages: string; oldest_waiting_at: Date | null; oldest_pending_job_at: Date | null;
    }>(`select
      (select count(*) from sms_kit.template t join sms_kit.signature s on s.id = t.signature_id where t.enabled and s.enabled and lower(t.external_status) in ('approved','audit_state_pass') and lower(s.external_status) in ('approved','audit_state_pass'))::text as usable_templates,
      (select count(*) from sms_kit.send_message where tenant_id = $1 and delivery_status = 'waiting')::text as waiting_messages,
      (select min(submitted_at) from sms_kit.send_message where tenant_id = $1 and delivery_status = 'waiting') as oldest_waiting_at,
      (select min(available_at) from sms_kit.send_job where tenant_id = $1 and state in ('pending','leased','failed')) as oldest_pending_job_at,
      (select count(*) from sms_kit.send_job where tenant_id = $1 and state in ('pending', 'leased', 'failed'))::text as pending_jobs,
      (select count(*) from sms_kit.send_message where tenant_id = $1 and acceptance_status = 'unknown')::text as acceptance_unknown,
      (select count(*) from sms_kit.send_message where tenant_id = $1 and delivery_status = 'unknown_final')::text as final_unknown,
      (select count(*) from sms_kit.delivery_receipt where match_status = 'unmatched')::text as unmatched_receipts,
      (select coalesce(held_count, 0) from sms_kit.daily_send_budget where budget_date = ($2 at time zone 'UTC')::date)::text as held_budget_count,
      (select max(received_at) from sms_kit.delivery_receipt where tenant_id = $1 and source = 'callback') as last_receipt_at`, [input.tenantId, input.now]);
    const row = rows[0];
    return {
      pendingJobs: count(row?.pending_jobs), acceptanceUnknown: count(row?.acceptance_unknown), finalUnknown: count(row?.final_unknown),
      unmatchedReceipts: count(row?.unmatched_receipts), heldBudgetCount: count(row?.held_budget_count),
      usableTemplates: count(row?.usable_templates), waitingMessages: count(row?.waiting_messages),
      ...(row?.oldest_waiting_at == null ? {} : { oldestWaitingAt: row.oldest_waiting_at }),
      ...(row?.oldest_pending_job_at == null ? {} : { oldestPendingJobAt: row.oldest_pending_job_at }),
      ...(row?.last_receipt_at === null || row?.last_receipt_at === undefined ? {} : { lastReceiptAt: row.last_receipt_at }),
    };
  }
}
