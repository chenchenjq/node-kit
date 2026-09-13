import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { Attempt, AttemptRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type AttemptRow = { id: string; tenant_id: string; message_id: string; attempt_no: number; status: Attempt["status"]; dispatch_mode: Attempt["dispatchMode"]; dispatch_token: string; lease_token: string | null; dispatch_marked_at: Date; provider_request_id: string | null; provider_code: string | null; error_code: string | null; latency_ms: number | null; occurred_at: Date };
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function attempt(row: AttemptRow): Attempt {
  return { id: row.id, tenantId: row.tenant_id as Attempt["tenantId"], messageId: row.message_id as Attempt["messageId"], attemptNo: row.attempt_no, status: row.status, dispatchMode: row.dispatch_mode, dispatchToken: row.dispatch_token, ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }), dispatchMarkedAt: row.dispatch_marked_at, ...(row.provider_request_id === null ? {} : { providerRequestId: row.provider_request_id }), ...(row.provider_code === null ? {} : { providerCode: row.provider_code }), ...(row.error_code === null ? {} : { errorCode: row.error_code }), ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }), occurredAt: row.occurred_at };
}
const fields = "a.id, m.tenant_id, a.message_id, a.attempt_no, a.status, a.dispatch_mode, a.dispatch_token, a.lease_token, a.dispatch_marked_at, a.provider_request_id, a.provider_code, a.error_code, a.latency_ms, a.occurred_at";

export class PgAttemptRepository implements AttemptRepository {
  constructor(private readonly pool: Pool) {}

  async createStarted(input: Readonly<{ tenantId: Attempt["tenantId"]; messageId: Attempt["messageId"]; dispatchMode: "direct" | "queued"; leaseToken?: string; dispatchMarkedAt: Date }>, tx?: SmsTransaction): Promise<Attempt> {
    const client = db(this.pool, tx);
    if ((input.dispatchMode === "queued") !== (input.leaseToken !== undefined)) throw new SmsKitError("CONCURRENT_MODIFICATION", "dispatch mode requires its matching lease token");
    if (input.dispatchMode === "queued") {
      const lease = await client.query("select id from sms_kit.send_job where tenant_id = $1 and message_id = $2 and state = 'leased' and lease_token = $3", [input.tenantId, input.messageId, input.leaseToken]);
      if (lease.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
    }
    const inserted = await client.query<AttemptRow>(
      `with next_attempt as (select coalesce(max(attempt_no), 0) + 1 as attempt_no from sms_kit.send_attempt where message_id = $2)
       insert into sms_kit.send_attempt (id, message_id, attempt_no, status, dispatch_mode, dispatch_token, lease_token, dispatch_marked_at, occurred_at)
       select $1, $2, next_attempt.attempt_no, 'started', $3, $4, $5, $6, $6 from next_attempt
       returning id, $7::text as tenant_id, message_id, attempt_no, status, dispatch_mode, dispatch_token, lease_token, dispatch_marked_at, provider_request_id, provider_code, error_code, latency_ms, occurred_at`,
      [randomUUID(), input.messageId, input.dispatchMode, randomUUID(), input.leaseToken ?? null, input.dispatchMarkedAt, input.tenantId],
    ).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new SmsKitError("CONCURRENT_MODIFICATION", "message already has a started attempt");
      throw error;
    });
    if (inserted.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "attempt could not be created");
    return attempt(inserted.rows[0]);
  }

  async completeByDispatchToken(input: Readonly<{ tenantId: Attempt["tenantId"]; dispatchToken: string; status: "accepted" | "rejected" | "unknown"; providerRequestId?: string; providerCode?: string; errorCode?: string; latencyMs?: number; occurredAt: Date }>, tx?: SmsTransaction): Promise<Attempt> {
    const { rows } = await db(this.pool, tx).query<AttemptRow>(
      `update sms_kit.send_attempt a set status = $1, provider_request_id = $2, provider_code = $3, error_code = $4, latency_ms = $5, occurred_at = $6
        from sms_kit.send_message m where a.message_id = m.id and m.tenant_id = $7 and a.dispatch_token = $8 and a.status = 'started'
      returning a.id, m.tenant_id, a.message_id, a.attempt_no, a.status, a.dispatch_mode, a.dispatch_token, a.lease_token, a.dispatch_marked_at, a.provider_request_id, a.provider_code, a.error_code, a.latency_ms, a.occurred_at`,
      [input.status, input.providerRequestId ?? null, input.providerCode ?? null, input.errorCode ?? null, input.latencyMs ?? null, input.occurredAt, input.tenantId, input.dispatchToken],
    );
    if (rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "attempt is no longer started");
    return attempt(rows[0]);
  }

  async listExpiredStarted(input: Readonly<{ tenantId: Attempt["tenantId"]; before: Date; limit: number }>, tx?: SmsTransaction): Promise<readonly Attempt[]> {
    const { rows } = await db(this.pool, tx).query<AttemptRow>(`select ${fields} from sms_kit.send_attempt a join sms_kit.send_message m on m.id = a.message_id where m.tenant_id = $1 and a.status = 'started' and a.dispatch_marked_at < $2 order by a.dispatch_marked_at limit $3`, [input.tenantId, input.before, input.limit]);
    return rows.map(attempt);
  }
}
