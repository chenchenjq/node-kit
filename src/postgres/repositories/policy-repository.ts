import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { TenantId } from "../../core/types.js";
import type { BudgetReservation, PolicyStore, VerificationPolicy, VerificationPolicyUpdate } from "../../ports/policy.js";
import type { SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type PolicyRow = { version: string; otp_length: number; otp_ttl_seconds: number; otp_max_attempts: number; proof_ttl_seconds: number; phone_min_interval_seconds: number; phone_hourly_limit: number; phone_daily_limit: number; ip_window_seconds: number; ip_window_limit: number; system_daily_budget: number | null; circuit_open: boolean; circuit_reason: string | null };
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function policy(row: PolicyRow): VerificationPolicy { return { version: Number(row.version), otpLength: row.otp_length, otpTtlSeconds: row.otp_ttl_seconds, otpMaxAttempts: row.otp_max_attempts, proofTtlSeconds: row.proof_ttl_seconds, phoneMinIntervalSeconds: row.phone_min_interval_seconds, phoneHourlyLimit: row.phone_hourly_limit, phoneDailyLimit: row.phone_daily_limit, ipWindowSeconds: row.ip_window_seconds, ipWindowLimit: row.ip_window_limit, systemDailyBudget: row.system_daily_budget, circuitOpen: row.circuit_open, ...(row.circuit_reason === null ? {} : { circuitReason: row.circuit_reason }) }; }
const fields = "version, otp_length, otp_ttl_seconds, otp_max_attempts, proof_ttl_seconds, phone_min_interval_seconds, phone_hourly_limit, phone_daily_limit, ip_window_seconds, ip_window_limit, system_daily_budget, circuit_open, circuit_reason";

export class PgPolicyStore implements PolicyStore {
  constructor(private readonly pool: Pool) {}

  async get(tx?: SmsTransaction): Promise<VerificationPolicy> {
    const client = db(this.pool, tx);
    await client.query("insert into sms_kit.policy_config (id, created_at, updated_at) values (1, now(), now()) on conflict (id) do nothing");
    const { rows } = await client.query<PolicyRow>(`select ${fields} from sms_kit.policy_config where id = 1`);
    if (rows[0] === undefined) throw new SmsKitError("STORAGE_FAILURE", "policy configuration is not initialized", true);
    return policy(rows[0]);
  }

  async update(input: VerificationPolicyUpdate, tx?: SmsTransaction): Promise<VerificationPolicy> {
    const { rows } = await db(this.pool, tx).query<PolicyRow>(
      `update sms_kit.policy_config set otp_length = $1, otp_ttl_seconds = $2, otp_max_attempts = $3, proof_ttl_seconds = $4,
       phone_min_interval_seconds = $5, phone_hourly_limit = $6, phone_daily_limit = $7, ip_window_seconds = $8, ip_window_limit = $9,
       system_daily_budget = $10, circuit_open = $11, circuit_reason = $12, circuit_opened_at = case when $11 then now() else null end,
       version = version + 1, updated_at = now() where id = 1 and version = $13 returning ${fields}`,
      [input.otpLength, input.otpTtlSeconds, input.otpMaxAttempts, input.proofTtlSeconds, input.phoneMinIntervalSeconds, input.phoneHourlyLimit, input.phoneDailyLimit, input.ipWindowSeconds, input.ipWindowLimit, input.systemDailyBudget, input.circuitOpen, input.circuitReason ?? null, input.expectedVersion],
    );
    if (rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "policy configuration changed concurrently");
    return policy(rows[0]);
  }

  async holdBudget(input: Readonly<{ tenantId: TenantId; messageId: BudgetReservation["messageId"]; now: Date }>, tx: SmsTransaction): Promise<BudgetReservation> {
    const client = db(this.pool, tx);
    const settings = await client.query<PolicyRow>(`select ${fields} from sms_kit.policy_config where id = 1 for update`);
    if (settings.rows[0] === undefined) throw new SmsKitError("STORAGE_FAILURE", "policy configuration is not initialized", true);
    const current = policy(settings.rows[0]);
    if (current.circuitOpen) throw new SmsKitError("CIRCUIT_OPEN", "sending circuit is open");
    const owned = await client.query<{ id: string }>("select id from sms_kit.send_message where id = $1 and tenant_id = $2 for update", [input.messageId, input.tenantId]);
    if (owned.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "message is outside the trusted tenant");
    const existing = await client.query<{ budget_date: string; state: "held" | "released" }>("select budget_date::text, state from sms_kit.send_budget_reservation where message_id = $1", [input.messageId]);
    if (existing.rows[0] !== undefined) return { messageId: input.messageId, budgetDate: existing.rows[0].budget_date, state: existing.rows[0].state };
    const budgetDate = input.now.toISOString().slice(0, 10);
    await client.query("insert into sms_kit.daily_send_budget (budget_date, held_count, updated_at) values ($1::date, 0, now()) on conflict (budget_date) do nothing", [budgetDate]);
    const budget = await client.query<{ held_count: string }>("select held_count::text from sms_kit.daily_send_budget where budget_date = $1::date for update", [budgetDate]);
    if (budget.rows[0] === undefined) throw new SmsKitError("STORAGE_FAILURE", "daily budget is not initialized", true);
    if (current.systemDailyBudget !== null && Number(budget.rows[0].held_count) >= current.systemDailyBudget) throw new SmsKitError("BUDGET_EXCEEDED", "system daily budget is exhausted");
    await client.query("insert into sms_kit.send_budget_reservation (id, message_id, budget_date, state, held_at) values ($1, $2, $3::date, 'held', now())", [randomUUID(), input.messageId, budgetDate]);
    await client.query("update sms_kit.daily_send_budget set held_count = held_count + 1, version = version + 1, updated_at = now() where budget_date = $1::date", [budgetDate]);
    return { messageId: input.messageId, budgetDate, state: "held" };
  }

  async releaseBudget(input: Readonly<{ tenantId: TenantId; messageId: BudgetReservation["messageId"] }>, tx: SmsTransaction): Promise<boolean> {
    const client = db(this.pool, tx);
    const released = await client.query<{ budget_date: string }>(`update sms_kit.send_budget_reservation r set state = 'released', released_at = now() from sms_kit.send_message m where r.message_id = m.id and r.message_id = $1 and m.tenant_id = $2 and r.state = 'held' returning r.budget_date::text`, [input.messageId, input.tenantId]);
    if (released.rows[0] === undefined) return false;
    await client.query("update sms_kit.daily_send_budget set held_count = held_count - 1, version = version + 1, updated_at = now() where budget_date = $1::date and held_count > 0", [released.rows[0].budget_date]);
    return true;
  }
}
