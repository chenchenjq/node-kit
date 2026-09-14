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
}
