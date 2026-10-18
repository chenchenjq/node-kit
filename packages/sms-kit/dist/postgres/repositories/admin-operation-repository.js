import { SmsKitError } from "../../core/errors.js";
import { scopeTenantId } from "../../core/types.js";
function executor(pool, tx) {
    return tx === undefined ? pool : tx.client;
}
function replay(row, requestChecksum) {
    if (row.request_checksum !== requestChecksum) {
        throw new SmsKitError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with different input");
    }
    if (row.result_snapshot === null) {
        throw new SmsKitError("STORAGE_FAILURE", "admin operation is incomplete", true);
    }
    return row.result_snapshot;
}
export class PgAdminOperationRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async find(input, tx) {
        const { rows } = await executor(this.pool, tx).query(`select request_checksum, result_snapshot
         from sms_kit.admin_operation
        where scope_type = $1 and tenant_id is not distinct from $2 and operation = $3 and idempotency_key = $4`, [input.scope.scopeType, scopeTenantId(input.scope), input.operation, input.idempotencyKey]);
        return rows[0] === undefined ? undefined : replay(rows[0], input.requestChecksum);
    }
    async claim(input, tx) {
        const db = executor(this.pool, tx);
        const inserted = await db.query(`insert into sms_kit.admin_operation (
         scope_type, tenant_id, operation, idempotency_key, request_checksum, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, now(), now())
       on conflict do nothing
       returning scope_type`, [input.scope.scopeType, scopeTenantId(input.scope), input.operation, input.idempotencyKey, input.requestChecksum]);
        if (inserted.rowCount === 1)
            return { kind: "claimed" };
        const { rows } = await db.query(`select request_checksum, result_snapshot
         from sms_kit.admin_operation
        where scope_type = $1 and tenant_id is not distinct from $2 and operation = $3 and idempotency_key = $4
        for update`, [input.scope.scopeType, scopeTenantId(input.scope), input.operation, input.idempotencyKey]);
        if (rows[0] === undefined) {
            throw new SmsKitError("STORAGE_FAILURE", "admin operation claim could not be read", true);
        }
        return { kind: "replay", resultSnapshot: replay(rows[0], input.requestChecksum) };
    }
    async complete(input, tx) {
        const serialized = JSON.stringify(input.resultSnapshot);
        if (serialized === undefined || input.resultSnapshot === null || Array.isArray(input.resultSnapshot)) {
            throw new SmsKitError("STORAGE_FAILURE", "admin operation result is invalid", true);
        }
        const updated = await executor(this.pool, tx).query(`update sms_kit.admin_operation
          set result_snapshot = $6::jsonb, completed_at = now(), updated_at = now()
        where scope_type = $1 and tenant_id is not distinct from $2 and operation = $3 and idempotency_key = $4
          and request_checksum = $5 and result_snapshot is null`, [input.scope.scopeType, scopeTenantId(input.scope), input.operation, input.idempotencyKey, input.requestChecksum, serialized]);
        if (updated.rowCount !== 1) {
            throw new SmsKitError("CONCURRENT_MODIFICATION", "admin operation is no longer claimable");
        }
    }
    async authorizeJob(input, tx) {
        const db = executor(this.pool, tx);
        const inserted = await db.query(`insert into sms_kit.admin_job_authorization (
         scope_type, tenant_id, job_id, operation, idempotency_key, required_permission, created_at
       )
       select 'TENANT', job.tenant_id, job.id, operation.operation,
              operation.idempotency_key, $5, now()
         from sms_kit.send_job job
         join sms_kit.admin_operation operation
           on operation.tenant_id = job.tenant_id
          and operation.operation = $2
          and operation.idempotency_key = $3
        where job.tenant_id = $1 and job.id = $4
          and job.job_type = 'reconcile' and job.origin_action is null
       on conflict do nothing
       returning job_id`, [input.tenantId, input.operation, input.idempotencyKey, input.jobId, input.requiredPermission]);
        if (inserted.rowCount === 1)
            return;
        const existing = await db.query(`select job_auth.job_id
         from sms_kit.admin_job_authorization job_auth
         join sms_kit.send_job job
           on job.tenant_id = job_auth.tenant_id and job.id = job_auth.job_id
        where job_auth.tenant_id = $1 and job_auth.job_id = $2
          and job_auth.required_permission = $3
          and job.job_type = 'reconcile' and job.origin_action is null`, [input.tenantId, input.jobId, input.requiredPermission]);
        if (existing.rowCount !== 1) {
            throw new SmsKitError("CONCURRENT_MODIFICATION", "job cannot inherit this admin authorization");
        }
    }
    async findJobAuthorization(input, tx) {
        const { rows } = await executor(this.pool, tx).query(`select job_auth.required_permission
         from sms_kit.admin_job_authorization job_auth
         join sms_kit.send_job job
           on job.tenant_id = job_auth.tenant_id and job.id = job_auth.job_id
        where job_auth.tenant_id = $1 and job_auth.job_id = $2
          and job_auth.required_permission = 'receipt.reconcile'
          and job.job_type = 'reconcile' and job.origin_action is null`, [input.tenantId, input.jobId]);
        return rows[0] === undefined ? undefined : { requiredPermission: rows[0].required_permission };
    }
}
