import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { MessageId } from "../../core/types.js";
import type { Job, JobOriginAction, JobRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Row = { id: string; tenant_id: string; dedupe_key: string; job_type: Job["jobType"]; message_id: string | null; state: Job["state"]; available_at: Date; lease_owner: string | null; lease_token: string | null; lease_generation: string; lease_until: Date | null; attempt_count: number; max_attempts: number; last_error_code: string | null; origin_action: string | null; payload: Job["payload"] };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function originAction(row: Row): JobOriginAction | undefined {
  if (row.origin_action === null) return undefined;
  if (row.origin_action === "sms.test" || row.origin_action === "receipt.reconcile") return row.origin_action;
  throw new SmsKitError("STORAGE_FAILURE", "job origin is invalid", true);
}
function job(row: Row): Job {
  const action = originAction(row);
  return {
    id: row.id, tenantId: row.tenant_id as Job["tenantId"], dedupeKey: row.dedupe_key, jobType: row.job_type,
    ...(row.message_id === null ? {} : { messageId: row.message_id as MessageId }), state: row.state,
    availableAt: row.available_at, ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }), leaseGeneration: Number(row.lease_generation),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }), attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts, ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(action === undefined ? {} : { originAction: action }), payload: row.payload,
  };
}
const fields = "id, tenant_id, dedupe_key, job_type, message_id, state, available_at, lease_owner, lease_token, lease_generation, lease_until, attempt_count, max_attempts, last_error_code, origin_action, payload";
const targetFields = fields.split(", ").map((field) => `job.${field}`).join(", ");

export class PgJobRepository implements JobRepository {
  constructor(private readonly pool: Pool) {}

  async get(input: Readonly<{ tenantId: Job["tenantId"]; id: string }>, tx?: SmsTransaction): Promise<Job | undefined> {
    if (!uuidPattern.test(input.id)) return undefined;
    const { rows } = await db(this.pool, tx).query<Row>(`select ${fields} from sms_kit.send_job where tenant_id = $1 and id = $2`, [input.tenantId, input.id]);
    return rows[0] === undefined ? undefined : job(rows[0]);
  }

  async getForUpdate(input: Readonly<{ tenantId: Job["tenantId"]; id: string }>, tx: SmsTransaction): Promise<Job | undefined> {
    if (!uuidPattern.test(input.id)) return undefined;
    const { rows } = await db(this.pool, tx).query<Row>(`select ${fields} from sms_kit.send_job where tenant_id = $1 and id = $2 for update`, [input.tenantId, input.id]);
    return rows[0] === undefined ? undefined : job(rows[0]);
  }

  async lease(input: Readonly<{ tenantId?: Job["tenantId"]; jobType?: Job["jobType"]; owner: string; leaseMs: number; limit: number; now: Date }>, tx?: SmsTransaction): Promise<readonly Job[]> {
    const { rows } = await db(this.pool, tx).query<Row>(
      `with candidate as (
         select id from sms_kit.send_job where ($1::text is null or tenant_id = $1) and ($2::text is null or job_type = $2)
           and state = 'pending' and available_at <= $3
         order by available_at, id for update skip locked limit $4
       ) update sms_kit.send_job j set state = 'leased', lease_owner = $5,
         lease_token = md5(random()::text || clock_timestamp()::text || j.id::text)::uuid,
         lease_generation = lease_generation + 1, lease_until = $3 + ($6 * interval '1 millisecond'), updated_at = now()
       from candidate c where j.id = c.id returning j.id, j.tenant_id, j.dedupe_key, j.job_type, j.message_id, j.state, j.available_at, j.lease_owner, j.lease_token, j.lease_generation, j.lease_until, j.attempt_count, j.max_attempts, j.last_error_code, j.origin_action, j.payload`,
      [input.tenantId ?? null, input.jobType ?? null, input.now, input.limit, input.owner, input.leaseMs],
    );
    return rows.map(job);
  }

  async leaseReconciliation(input: Parameters<JobRepository["leaseReconciliation"]>[0], tx?: SmsTransaction): Promise<readonly Job[]> {
    const { rows } = await db(this.pool, tx).query<Row>(
      `with candidate as (
         select job.id from sms_kit.send_job job
           join sms_kit.send_message message on message.id = job.message_id and message.tenant_id = job.tenant_id
          where job.job_type = 'reconcile' and (
              (job.state = 'pending' and job.available_at <= $1)
              or (job.state = 'leased' and job.lease_until < $1)
            )
            and message.acceptance_status in ('accepted', 'unknown')
            and message.delivery_status in ('waiting', 'delivered', 'failed', 'unknown_final')
          order by job.available_at, job.id for update of job, message skip locked limit $2
       ) update sms_kit.send_job job set state = 'leased', lease_owner = $3,
         lease_token = md5(random()::text || clock_timestamp()::text || job.id::text)::uuid,
         lease_generation = lease_generation + 1, lease_until = $1 + ($4 * interval '1 millisecond'), updated_at = now()
       from candidate where job.id = candidate.id returning ${targetFields}`,
      [input.now, input.limit, input.owner, input.leaseMs],
    );
    return rows.map(job);
  }

  async renew(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string; leaseMs: number; now: Date }>, tx?: SmsTransaction): Promise<Job> {
    const { rows } = await db(this.pool, tx).query<Row>(`update sms_kit.send_job set lease_until = $1 + ($2 * interval '1 millisecond'), updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5 and lease_until > $1 returning ${fields}`, [input.now, input.leaseMs, input.tenantId, input.id, input.leaseToken]);
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

  async trySucceed(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string }>, tx?: SmsTransaction): Promise<boolean> {
    const result = await db(this.pool, tx).query(
      "update sms_kit.send_job set state = 'succeeded', lease_owner = null, lease_token = null, lease_until = null, updated_at = now() where tenant_id = $1 and id = $2 and state = 'leased' and lease_token = $3",
      [input.tenantId, input.id, input.leaseToken],
    );
    return result.rowCount === 1;
  }

  async trySucceedByLeaseToken(input: Readonly<{ tenantId: Job["tenantId"]; messageId: MessageId; leaseToken: string }>, tx?: SmsTransaction): Promise<boolean> {
    const result = await db(this.pool, tx).query(
      "update sms_kit.send_job set state = 'succeeded', lease_owner = null, lease_token = null, lease_until = null, updated_at = now() where tenant_id = $1 and message_id = $2 and job_type = 'send' and state = 'leased' and lease_token = $3",
      [input.tenantId, input.messageId, input.leaseToken],
    );
    return result.rowCount === 1;
  }

  async tryReschedule(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string; availableAt: Date; errorCode?: string }>, tx?: SmsTransaction): Promise<boolean> {
    const result = await db(this.pool, tx).query(
      "update sms_kit.send_job set state = 'pending', available_at = $1, lease_owner = null, lease_token = null, lease_until = null, attempt_count = attempt_count + 1, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5",
      [input.availableAt, input.errorCode ?? null, input.tenantId, input.id, input.leaseToken],
    );
    return result.rowCount === 1;
  }

  async tryFail(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string; errorCode: string; terminal: boolean }>, tx?: SmsTransaction): Promise<boolean> {
    const result = await db(this.pool, tx).query(
      "update sms_kit.send_job set state = $1, lease_owner = null, lease_token = null, lease_until = null, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5",
      [input.terminal ? "dead" : "failed", input.errorCode, input.tenantId, input.id, input.leaseToken],
    );
    return result.rowCount === 1;
  }

  async ensureReconcile(input: Readonly<{ tenantId: Job["tenantId"]; messageId: MessageId; availableAt: Date; originAction?: JobOriginAction }>, tx?: SmsTransaction): Promise<Job> {
    const requestedOrigin: unknown = input.originAction;
    if (requestedOrigin !== undefined && requestedOrigin !== "sms.test" && requestedOrigin !== "receipt.reconcile") {
      throw new SmsKitError("CONFIG_INVALID", "reconciliation job origin is invalid");
    }
    const database = db(this.pool, tx);
    const dedupeKey = `reconcile:${input.messageId}`;
    // A reconciliation worker fences its lease before locking the message.
    // Callers that already hold the message lock must therefore reuse an
    // existing job through an MVCC read, without taking the opposite job lock.
    const existing = await database.query<Row>(
      `select ${fields} from sms_kit.send_job
        where tenant_id = $1 and job_type = 'reconcile' and dedupe_key = $2`,
      [input.tenantId, dedupeKey],
    );
    if (existing.rows[0] !== undefined) return job(existing.rows[0]);

    const inserted = await database.query<Row>(
      `insert into sms_kit.send_job (id, tenant_id, dedupe_key, job_type, message_id, state, available_at, attempt_count, max_attempts, origin_action, payload, created_at, updated_at)
       values ($1, $2, $3, 'reconcile', $4, 'pending', $5, 0, 1, $6, '{"kind":"reconcile"}'::jsonb, now(), now())
       on conflict (tenant_id, job_type, dedupe_key)
       -- The first creator establishes the action provenance. A later manual
       -- request may observe the existing job but must not relabel a worker job
       -- or grant a different future read permission.
       do nothing
       returning ${fields}`,
      [randomUUID(), input.tenantId, dedupeKey, input.messageId, input.availableAt, input.originAction ?? null],
    );
    if (inserted.rows[0] !== undefined) return job(inserted.rows[0]);

    // ON CONFLICT DO NOTHING waits for a concurrent first creator to commit;
    // the next READ COMMITTED statement can then return that durable winner.
    const raced = await database.query<Row>(
      `select ${fields} from sms_kit.send_job
        where tenant_id = $1 and job_type = 'reconcile' and dedupe_key = $2`,
      [input.tenantId, dedupeKey],
    );
    if (raced.rows[0] === undefined) throw new SmsKitError("STORAGE_FAILURE", "reconciliation job could not be read", true);
    return job(raced.rows[0]);
  }

  async lockExpiredSendJobs(input: Readonly<{ before: Date; limit: number }>, tx: SmsTransaction): Promise<readonly Job[]> {
    const { rows } = await db(this.pool, tx).query<Row>(
      `select ${fields} from sms_kit.send_job
        where job_type = 'send' and state = 'leased' and lease_until < $1
        order by lease_until, id for update skip locked limit $2`,
      [input.before, input.limit],
    );
    return rows.map(job);
  }

  async returnToPendingIfNoStarted(input: Readonly<{ tenantId: Job["tenantId"]; id: string; leaseToken: string }>, tx: SmsTransaction): Promise<boolean> {
    const result = await db(this.pool, tx).query(
      `update sms_kit.send_job j set state = 'pending', lease_owner = null, lease_token = null, lease_until = null, updated_at = now()
        where j.tenant_id = $1 and j.id = $2 and j.job_type = 'send' and j.state = 'leased' and j.lease_token = $3
          and not exists (select 1 from sms_kit.send_attempt a where a.message_id = j.message_id and a.status = 'started')`,
      [input.tenantId, input.id, input.leaseToken],
    );
    return result.rowCount === 1;
  }
}
