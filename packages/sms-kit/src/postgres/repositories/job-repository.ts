import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { MessageId } from "../../core/types.js";
import type { Job, JobRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Row = { id: string; tenant_id: string; dedupe_key: string; job_type: Job["jobType"]; message_id: string | null; state: Job["state"]; available_at: Date; lease_owner: string | null; lease_token: string | null; lease_generation: string; lease_until: Date | null; attempt_count: number; max_attempts: number; last_error_code: string | null; payload: Job["payload"] };
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function job(row: Row): Job { return { id: row.id, tenantId: row.tenant_id as Job["tenantId"], dedupeKey: row.dedupe_key, jobType: row.job_type, ...(row.message_id === null ? {} : { messageId: row.message_id as MessageId }), state: row.state, availableAt: row.available_at, ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }), ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }), leaseGeneration: Number(row.lease_generation), ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }), attemptCount: row.attempt_count, maxAttempts: row.max_attempts, ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }), payload: row.payload }; }
const fields = "id, tenant_id, dedupe_key, job_type, message_id, state, available_at, lease_owner, lease_token, lease_generation, lease_until, attempt_count, max_attempts, last_error_code, payload";

export class PgJobRepository implements JobRepository {
  constructor(private readonly pool: Pool) {}

  async get(input: Readonly<{ tenantId: Job["tenantId"]; id: string }>, tx?: SmsTransaction): Promise<Job | undefined> {
    const { rows } = await db(this.pool, tx).query<Row>(`select ${fields} from sms_kit.send_job where tenant_id = $1 and id = $2`, [input.tenantId, input.id]);
    return rows[0] === undefined ? undefined : job(rows[0]);
  }

  async lease(input: Readonly<{ tenantId: Job["tenantId"]; owner: string; leaseMs: number; limit: number; now: Date }>, tx?: SmsTransaction): Promise<readonly Job[]> {
    const { rows } = await db(this.pool, tx).query<Row>(
      `with candidate as (
         select id from sms_kit.send_job where tenant_id = $1 and state = 'pending' and available_at <= $2
         order by available_at, id for update skip locked limit $3
       ) update sms_kit.send_job j set state = 'leased', lease_owner = $4, lease_token = $5,
         lease_generation = lease_generation + 1, lease_until = $2 + ($6 * interval '1 millisecond'), updated_at = now()
       from candidate c where j.id = c.id returning j.id, j.tenant_id, j.dedupe_key, j.job_type, j.message_id, j.state, j.available_at, j.lease_owner, j.lease_token, j.lease_generation, j.lease_until, j.attempt_count, j.max_attempts, j.last_error_code, j.payload`,
      [input.tenantId, input.now, input.limit, input.owner, randomUUID(), input.leaseMs],
    );
    return rows.map(job);
  }

  async renew(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string; leaseMs: number; now: Date }>, tx?: SmsTransaction): Promise<Job> {
    const { rows } = await db(this.pool, tx).query<Row>(`update sms_kit.send_job set lease_until = $1 + ($2 * interval '1 millisecond'), updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5 returning ${fields}`, [input.now, input.leaseMs, input.tenantId, input.id, input.leaseToken]);
    if (rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
    return job(rows[0]);
  }

  async reschedule(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string; availableAt: Date; errorCode?: string }>, tx?: SmsTransaction): Promise<Job> {
    const { rows } = await db(this.pool, tx).query<Row>(`update sms_kit.send_job set state = 'pending', available_at = $1, lease_owner = null, lease_token = null, lease_until = null, attempt_count = attempt_count + 1, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5 returning ${fields}`, [input.availableAt, input.errorCode ?? null, input.tenantId, input.id, input.leaseToken]);
    if (rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
    return job(rows[0]);
  }

  async succeed(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string }>, tx?: SmsTransaction): Promise<Job> {
    const { rows } = await db(this.pool, tx).query<Row>(`update sms_kit.send_job set state = 'succeeded', lease_owner = null, lease_token = null, lease_until = null, updated_at = now() where tenant_id = $1 and id = $2 and state = 'leased' and lease_token = $3 returning ${fields}`, [input.tenantId, input.id, input.leaseToken]);
    if (rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
    return job(rows[0]);
  }

  async fail(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string; errorCode: string; terminal: boolean }>, tx?: SmsTransaction): Promise<Job> {
    const { rows } = await db(this.pool, tx).query<Row>(`update sms_kit.send_job set state = $1, lease_owner = null, lease_token = null, lease_until = null, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5 returning ${fields}`, [input.terminal ? "dead" : "failed", input.errorCode, input.tenantId, input.id, input.leaseToken]);
    if (rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
    return job(rows[0]);
  }
}
