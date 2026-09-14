import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { TenantId } from "../../core/types.js";
import type {
  AdminOperationClaim,
  AdminOperationName,
  AdminOperationRepository,
  SmsTransaction,
} from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type AdminOperationRow = Readonly<{
  request_checksum: string;
  result_snapshot: Readonly<Record<string, unknown>> | null;
}>;

function executor(pool: Pool, tx?: SmsTransaction): Pool | PoolClient {
  return tx === undefined ? pool : (tx as PgSmsTransaction).client;
}

function replay(row: AdminOperationRow, requestChecksum: string): Readonly<Record<string, unknown>> {
  if (row.request_checksum !== requestChecksum) {
    throw new SmsKitError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with different input");
  }
  if (row.result_snapshot === null) {
    throw new SmsKitError("STORAGE_FAILURE", "admin operation is incomplete", true);
  }
  return row.result_snapshot;
}

export class PgAdminOperationRepository implements AdminOperationRepository {
  constructor(private readonly pool: Pool) {}

  async find(input: Readonly<{
    tenantId: TenantId;
    operation: AdminOperationName;
    idempotencyKey: string;
    requestChecksum: string;
  }>, tx?: SmsTransaction): Promise<Readonly<Record<string, unknown>> | undefined> {
    const { rows } = await executor(this.pool, tx).query<AdminOperationRow>(
      `select request_checksum, result_snapshot
         from sms_kit.admin_operation
        where tenant_id = $1 and operation = $2 and idempotency_key = $3`,
      [input.tenantId, input.operation, input.idempotencyKey],
    );
    return rows[0] === undefined ? undefined : replay(rows[0], input.requestChecksum);
  }

  async claim(input: Readonly<{
    tenantId: TenantId;
    operation: AdminOperationName;
    idempotencyKey: string;
    requestChecksum: string;
  }>, tx: SmsTransaction): Promise<AdminOperationClaim> {
    const db = executor(this.pool, tx);
    const inserted = await db.query(
      `insert into sms_kit.admin_operation (
         tenant_id, operation, idempotency_key, request_checksum, created_at, updated_at
       ) values ($1, $2, $3, $4, now(), now())
       on conflict (tenant_id, operation, idempotency_key) do nothing
       returning tenant_id`,
      [input.tenantId, input.operation, input.idempotencyKey, input.requestChecksum],
    );
    if (inserted.rowCount === 1) return { kind: "claimed" };

    const { rows } = await db.query<AdminOperationRow>(
      `select request_checksum, result_snapshot
         from sms_kit.admin_operation
        where tenant_id = $1 and operation = $2 and idempotency_key = $3
        for update`,
      [input.tenantId, input.operation, input.idempotencyKey],
    );
    if (rows[0] === undefined) {
      throw new SmsKitError("STORAGE_FAILURE", "admin operation claim could not be read", true);
    }
    return { kind: "replay", resultSnapshot: replay(rows[0], input.requestChecksum) };
  }

  async complete(input: Readonly<{
    tenantId: TenantId;
    operation: AdminOperationName;
    idempotencyKey: string;
    requestChecksum: string;
    resultSnapshot: Readonly<Record<string, unknown>>;
  }>, tx: SmsTransaction): Promise<void> {
    const serialized = JSON.stringify(input.resultSnapshot);
    if (serialized === undefined || input.resultSnapshot === null || Array.isArray(input.resultSnapshot)) {
      throw new SmsKitError("STORAGE_FAILURE", "admin operation result is invalid", true);
    }
    const updated = await executor(this.pool, tx).query(
      `update sms_kit.admin_operation
          set result_snapshot = $5::jsonb, completed_at = now(), updated_at = now()
        where tenant_id = $1 and operation = $2 and idempotency_key = $3
          and request_checksum = $4 and result_snapshot is null`,
      [input.tenantId, input.operation, input.idempotencyKey, input.requestChecksum, serialized],
    );
    if (updated.rowCount !== 1) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "admin operation is no longer claimable");
    }
  }

  async authorizeJob(input: Readonly<{
    tenantId: TenantId;
    operation: "receipt.reconcile";
    idempotencyKey: string;
    jobId: string;
    requiredPermission: "receipt.reconcile";
  }>, tx: SmsTransaction): Promise<void> {
    const db = executor(this.pool, tx);
    const inserted = await db.query(
      `insert into sms_kit.admin_job_authorization (
         tenant_id, job_id, operation, idempotency_key, required_permission, created_at
       )
       select job.tenant_id, job.id, operation.operation,
              operation.idempotency_key, $5, now()
         from sms_kit.send_job job
         join sms_kit.admin_operation operation
           on operation.tenant_id = job.tenant_id
          and operation.operation = $2
          and operation.idempotency_key = $3
        where job.tenant_id = $1 and job.id = $4
          and job.job_type = 'reconcile' and job.origin_action is null
       on conflict (tenant_id, job_id, required_permission) do nothing
       returning job_id`,
      [input.tenantId, input.operation, input.idempotencyKey, input.jobId, input.requiredPermission],
    );
    if (inserted.rowCount === 1) return;

    const existing = await db.query(
      `select job_auth.job_id
         from sms_kit.admin_job_authorization job_auth
         join sms_kit.send_job job
           on job.tenant_id = job_auth.tenant_id and job.id = job_auth.job_id
        where job_auth.tenant_id = $1 and job_auth.job_id = $2
          and job_auth.required_permission = $3
          and job.job_type = 'reconcile' and job.origin_action is null`,
      [input.tenantId, input.jobId, input.requiredPermission],
    );
    if (existing.rowCount !== 1) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "job cannot inherit this admin authorization");
    }
  }

  async findJobAuthorization(input: Readonly<{
    tenantId: TenantId;
    jobId: string;
  }>, tx?: SmsTransaction): Promise<Readonly<{ requiredPermission: "receipt.reconcile" }> | undefined> {
    const { rows } = await executor(this.pool, tx).query<{ required_permission: "receipt.reconcile" }>(
      `select job_auth.required_permission
         from sms_kit.admin_job_authorization job_auth
         join sms_kit.send_job job
           on job.tenant_id = job_auth.tenant_id and job.id = job_auth.job_id
        where job_auth.tenant_id = $1 and job_auth.job_id = $2
          and job_auth.required_permission = 'receipt.reconcile'
          and job.job_type = 'reconcile' and job.origin_action is null`,
      [input.tenantId, input.jobId],
    );
    return rows[0] === undefined ? undefined : { requiredPermission: rows[0].required_permission };
  }
}
