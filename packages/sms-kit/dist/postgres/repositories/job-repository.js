import { randomUUID } from "node:crypto";
import { SmsKitError } from "../../core/errors.js";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function db(pool, tx) { return tx === undefined ? pool : tx.client; }
function originAction(row) {
    if (row.origin_action === null)
        return undefined;
    if (row.origin_action === "sms.test" || row.origin_action === "receipt.reconcile")
        return row.origin_action;
    throw new SmsKitError("STORAGE_FAILURE", "job origin is invalid", true);
}
function job(row) {
    const action = originAction(row);
    return {
        id: row.id, tenantId: row.tenant_id, dedupeKey: row.dedupe_key, jobType: row.job_type,
        ...(row.message_id === null ? {} : { messageId: row.message_id }), state: row.state,
        availableAt: row.available_at, ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
        ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }), leaseGeneration: Number(row.lease_generation),
        ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }), attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts, ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
        ...(action === undefined ? {} : { originAction: action }), payload: row.payload,
    };
}
const fields = "id, tenant_id, dedupe_key, job_type, message_id, state, available_at, lease_owner, lease_token, lease_generation, lease_until, attempt_count, max_attempts, last_error_code, origin_action, payload";
const targetFields = fields.split(", ").map((field) => `job.${field}`).join(", ");
export class PgJobRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async get(input, tx) {
        if (!uuidPattern.test(input.id))
            return undefined;
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.send_job where tenant_id = $1 and id = $2`, [input.tenantId, input.id]);
        return rows[0] === undefined ? undefined : job(rows[0]);
    }
    async getForUpdate(input, tx) {
        if (!uuidPattern.test(input.id))
            return undefined;
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.send_job where tenant_id = $1 and id = $2 for update`, [input.tenantId, input.id]);
        return rows[0] === undefined ? undefined : job(rows[0]);
    }
    async lease(input, tx) {
        const { rows } = await db(this.pool, tx).query(`with candidate as (
         select id from sms_kit.send_job where ($1::text is null or tenant_id = $1) and ($2::text is null or job_type = $2)
           and state = 'pending' and available_at <= $3
         order by available_at, id for update skip locked limit $4
       ) update sms_kit.send_job j set state = 'leased', lease_owner = $5,
         lease_token = md5(random()::text || clock_timestamp()::text || j.id::text)::uuid,
         lease_generation = lease_generation + 1, lease_until = $3 + ($6 * interval '1 millisecond'), updated_at = now()
       from candidate c where j.id = c.id returning j.id, j.tenant_id, j.dedupe_key, j.job_type, j.message_id, j.state, j.available_at, j.lease_owner, j.lease_token, j.lease_generation, j.lease_until, j.attempt_count, j.max_attempts, j.last_error_code, j.origin_action, j.payload`, [input.tenantId ?? null, input.jobType ?? null, input.now, input.limit, input.owner, input.leaseMs]);
        return rows.map(job);
    }
    async leaseReconciliation(input, tx) {
        const { rows } = await db(this.pool, tx).query(`with candidate as (
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
       from candidate where job.id = candidate.id returning ${targetFields}`, [input.now, input.limit, input.owner, input.leaseMs]);
        return rows.map(job);
    }
    async renew(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.send_job set lease_until = $1 + ($2 * interval '1 millisecond'), updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5 and lease_until > $1 returning ${fields}`, [input.now, input.leaseMs, input.tenantId, input.id, input.leaseToken]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
        return job(rows[0]);
    }
    async reschedule(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.send_job set state = 'pending', available_at = $1, lease_owner = null, lease_token = null, lease_until = null, attempt_count = attempt_count + 1, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5 returning ${fields}`, [input.availableAt, input.errorCode ?? null, input.tenantId, input.id, input.leaseToken]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
        return job(rows[0]);
    }
    async succeed(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.send_job set state = 'succeeded', lease_owner = null, lease_token = null, lease_until = null, updated_at = now() where tenant_id = $1 and id = $2 and state = 'leased' and lease_token = $3 returning ${fields}`, [input.tenantId, input.id, input.leaseToken]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
        return job(rows[0]);
    }
    async fail(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.send_job set state = $1, lease_owner = null, lease_token = null, lease_until = null, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5 returning ${fields}`, [input.terminal ? "dead" : "failed", input.errorCode, input.tenantId, input.id, input.leaseToken]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "job lease is no longer current");
        return job(rows[0]);
    }
    async trySucceed(input, tx) {
        const result = await db(this.pool, tx).query("update sms_kit.send_job set state = 'succeeded', lease_owner = null, lease_token = null, lease_until = null, updated_at = now() where tenant_id = $1 and id = $2 and state = 'leased' and lease_token = $3", [input.tenantId, input.id, input.leaseToken]);
        return result.rowCount === 1;
    }
    async trySucceedByLeaseToken(input, tx) {
        const result = await db(this.pool, tx).query("update sms_kit.send_job set state = 'succeeded', lease_owner = null, lease_token = null, lease_until = null, updated_at = now() where tenant_id = $1 and message_id = $2 and job_type = 'send' and state = 'leased' and lease_token = $3", [input.tenantId, input.messageId, input.leaseToken]);
        return result.rowCount === 1;
    }
    async tryReschedule(input, tx) {
        const result = await db(this.pool, tx).query("update sms_kit.send_job set state = 'pending', available_at = $1, lease_owner = null, lease_token = null, lease_until = null, attempt_count = attempt_count + 1, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5", [input.availableAt, input.errorCode ?? null, input.tenantId, input.id, input.leaseToken]);
        return result.rowCount === 1;
    }
    async tryFail(input, tx) {
        const result = await db(this.pool, tx).query("update sms_kit.send_job set state = $1, lease_owner = null, lease_token = null, lease_until = null, last_error_code = $2, updated_at = now() where tenant_id = $3 and id = $4 and state = 'leased' and lease_token = $5", [input.terminal ? "dead" : "failed", input.errorCode, input.tenantId, input.id, input.leaseToken]);
        return result.rowCount === 1;
    }
    async ensureReconcile(input, tx) {
        const requestedOrigin = input.originAction;
        if (requestedOrigin !== undefined && requestedOrigin !== "sms.test" && requestedOrigin !== "receipt.reconcile") {
            throw new SmsKitError("CONFIG_INVALID", "reconciliation job origin is invalid");
        }
        const database = db(this.pool, tx);
        const dedupeKey = `reconcile:${input.messageId}`;
        // A reconciliation worker fences its lease before locking the message.
        // Callers that already hold the message lock must therefore reuse an
        // existing job through an MVCC read, without taking the opposite job lock.
        const existing = await database.query(`select ${fields} from sms_kit.send_job
        where tenant_id = $1 and job_type = 'reconcile' and dedupe_key = $2`, [input.tenantId, dedupeKey]);
        if (existing.rows[0] !== undefined)
            return job(existing.rows[0]);
        const inserted = await database.query(`insert into sms_kit.send_job (id, scope_type, tenant_id, dedupe_key, job_type, message_id, state, available_at, attempt_count, max_attempts, origin_action, payload, created_at, updated_at)
       values ($1, 'TENANT', $2, $3, 'reconcile', $4, 'pending', $5, 0, 1, $6, '{"kind":"reconcile"}'::jsonb, now(), now())
       on conflict (scope_type, (coalesce(tenant_id, '')), job_type, dedupe_key)
       -- The first creator establishes the action provenance. A later manual
       -- request may observe the existing job but must not relabel a worker job
       -- or grant a different future read permission.
       do nothing
       returning ${fields}`, [randomUUID(), input.tenantId, dedupeKey, input.messageId, input.availableAt, input.originAction ?? null]);
        if (inserted.rows[0] !== undefined)
            return job(inserted.rows[0]);
        // ON CONFLICT DO NOTHING waits for a concurrent first creator to commit;
        // the next READ COMMITTED statement can then return that durable winner.
        const raced = await database.query(`select ${fields} from sms_kit.send_job
        where tenant_id = $1 and job_type = 'reconcile' and dedupe_key = $2`, [input.tenantId, dedupeKey]);
        if (raced.rows[0] === undefined)
            throw new SmsKitError("STORAGE_FAILURE", "reconciliation job could not be read", true);
        return job(raced.rows[0]);
    }
    async lockExpiredSendJobs(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.send_job
        where job_type = 'send' and state = 'leased' and lease_until < $1
        order by lease_until, id for update skip locked limit $2`, [input.before, input.limit]);
        return rows.map(job);
    }
    async returnToPendingIfNoStarted(input, tx) {
        const result = await db(this.pool, tx).query(`update sms_kit.send_job j set state = 'pending', lease_owner = null, lease_token = null, lease_until = null, updated_at = now()
        where j.tenant_id = $1 and j.id = $2 and j.job_type = 'send' and j.state = 'leased' and j.lease_token = $3
          and not exists (select 1 from sms_kit.send_attempt a where a.message_id = j.message_id and a.status = 'started')`, [input.tenantId, input.id, input.leaseToken]);
        return result.rowCount === 1;
    }
}
