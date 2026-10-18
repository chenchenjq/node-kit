import { randomUUID } from "node:crypto";
import { SmsKitError } from "../../core/errors.js";
function db(pool, tx) { return tx === undefined ? pool : tx.client; }
function attempt(row) {
    return { id: row.id, tenantId: row.tenant_id, messageId: row.message_id, attemptNo: row.attempt_no, status: row.status, dispatchMode: row.dispatch_mode, dispatchToken: row.dispatch_token, ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }), dispatchMarkedAt: row.dispatch_marked_at, ...(row.provider_request_id === null ? {} : { providerRequestId: row.provider_request_id }), ...(row.provider_code === null ? {} : { providerCode: row.provider_code }), ...(row.error_code === null ? {} : { errorCode: row.error_code }), ...(row.latency_ms === null ? {} : { latencyMs: row.latency_ms }), occurredAt: row.occurred_at };
}
const fields = "a.id, m.tenant_id, a.message_id, a.attempt_no, a.status, a.dispatch_mode, a.dispatch_token, a.lease_token, a.dispatch_marked_at, a.provider_request_id, a.provider_code, a.error_code, a.latency_ms, a.occurred_at";
export class PgAttemptRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async countForMessage(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select count(*)::text as count
         from sms_kit.send_attempt attempt
         join sms_kit.send_message message on message.id = attempt.message_id
        where message.tenant_id = $1 and message.id = $2`, [input.tenantId, input.messageId]);
        const count = rows[0]?.count ?? "0";
        if (!/^(?:0|[1-9][0-9]*)$/.test(count)) {
            throw new SmsKitError("STORAGE_FAILURE", "attempt count is invalid", true);
        }
        const asBigInt = BigInt(count);
        return asBigInt <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : count;
    }
    async listForMessage(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${fields}
         from sms_kit.send_attempt a
         join sms_kit.send_message m on m.id = a.message_id
        where m.tenant_id = $1 and m.id = $2
        order by a.attempt_no, a.occurred_at, a.id`, [input.tenantId, input.messageId]);
        return rows.map(attempt);
    }
    async createStarted(input, tx) {
        const client = db(this.pool, tx);
        if ((input.dispatchMode === "queued") !== (input.leaseToken !== undefined))
            throw new SmsKitError("CONCURRENT_MODIFICATION", "dispatch mode requires its matching lease token");
        const inserted = await client.query(`with owned_message as (
         select id from sms_kit.send_message where tenant_id = $1 and id = $2 for update
       ), leased_job as (
         select j.id from sms_kit.send_job j join owned_message m on m.id = j.message_id
          where j.tenant_id = $1 and j.job_type = 'send' and j.state = 'leased' and j.lease_token = $5
            and j.lease_until > $8 for update
       ), eligible_message as (
         select id from owned_message where $3 = 'direct'
         union all
         select m.id from owned_message m where $3 = 'queued' and exists (select 1 from leased_job)
       ), next_attempt as (select coalesce(max(a.attempt_no), 0) + 1 as attempt_no from sms_kit.send_attempt a join eligible_message m on m.id = a.message_id)
       insert into sms_kit.send_attempt (id, message_id, attempt_no, status, dispatch_mode, dispatch_token, lease_token, dispatch_marked_at, occurred_at)
       select $4, m.id, next_attempt.attempt_no, 'started', $3, $6, $5, $7, $7 from eligible_message m cross join next_attempt
       returning id, $1::text as tenant_id, message_id, attempt_no, status, dispatch_mode, dispatch_token, lease_token, dispatch_marked_at, provider_request_id, provider_code, error_code, latency_ms, occurred_at`, [input.tenantId, input.messageId, input.dispatchMode, randomUUID(), input.leaseToken ?? null, randomUUID(), input.dispatchMarkedAt, input.minimumLeaseUntil ?? input.dispatchMarkedAt]).catch((error) => {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
                throw new SmsKitError("CONCURRENT_MODIFICATION", "message already has a started attempt");
            throw error;
        });
        if (inserted.rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "attempt could not be created");
        return attempt(inserted.rows[0]);
    }
    async lockByDispatchToken(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.send_attempt a join sms_kit.send_message m on m.id = a.message_id
        where m.tenant_id = $1 and a.dispatch_token = $2 for update of a, m`, [input.tenantId, input.dispatchToken]);
        return rows[0] === undefined ? undefined : attempt(rows[0]);
    }
    async completeByDispatchToken(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.send_attempt a set status = $1, provider_request_id = $2, provider_code = $3, error_code = $4, latency_ms = $5, occurred_at = $6
        from sms_kit.send_message m where a.message_id = m.id and m.tenant_id = $7 and a.dispatch_token = $8
          and (a.status = 'started' or (a.status = 'unknown' and $1 in ('accepted', 'rejected')))
      returning a.id, m.tenant_id, a.message_id, a.attempt_no, a.status, a.dispatch_mode, a.dispatch_token, a.lease_token, a.dispatch_marked_at, a.provider_request_id, a.provider_code, a.error_code, a.latency_ms, a.occurred_at`, [input.status, input.providerRequestId ?? null, input.providerCode ?? null, input.errorCode ?? null, input.latencyMs ?? null, input.occurredAt, input.tenantId, input.dispatchToken]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "attempt is no longer started");
        return attempt(rows[0]);
    }
    async listExpiredStarted(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.send_attempt a
        join sms_kit.send_message m on m.id = a.message_id
       where ($1::text is null or m.tenant_id = $1) and a.status = 'started'
         and a.dispatch_mode = 'direct' and a.dispatch_marked_at < $2
       order by a.dispatch_marked_at, a.id for update of a skip locked limit $3`, [input.tenantId ?? null, input.before, input.limit]);
        return rows.map(attempt);
    }
    async listStartedForLeasedJobs(input, tx) {
        if (input.jobs.length === 0)
            return [];
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.send_attempt a
        join sms_kit.send_message m on m.id = a.message_id
        join sms_kit.send_job j on j.message_id = a.message_id and j.job_type = 'send' and j.lease_token = a.lease_token
        join unnest($1::uuid[], $2::uuid[]) locked(id, lease_token) on j.id = locked.id and j.lease_token = locked.lease_token
       where a.status = 'started' and a.dispatch_mode = 'queued' and j.state = 'leased'
       order by a.dispatch_marked_at, a.id for update of a skip locked limit $3`, [input.jobs.map((job) => job.id), input.jobs.map((job) => job.leaseToken), input.limit]);
        return rows.map(attempt);
    }
}
