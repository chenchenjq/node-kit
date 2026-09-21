import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { AuditEvent, AuditRepository, SmsTransaction } from "../../ports/store.js";
import { projectSafeEventMetadata, type SafeEventMetadata } from "../../ports/runtime.js";
import { scopeTenantId, SYSTEM_SCOPE, tenantScope, type SmsScope, type TenantId } from "../../core/types.js";
import type { PgSmsTransaction } from "../transaction.js";

type AuditRow = { id: string; scope_type: SmsScope["scopeType"]; tenant_id: string | null; actor_id: string; action: string; target_type: string; target_id: string | null; result: AuditEvent["result"]; error_code: string | null; metadata: unknown; occurred_at: Date };
const fields = "id, scope_type, tenant_id, actor_id, action, target_type, target_id, result, error_code, metadata, occurred_at";
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function scope(row: AuditRow): SmsScope {
  if (row.scope_type === "SYSTEM" && row.tenant_id === null) return SYSTEM_SCOPE;
  if (row.scope_type === "TENANT" && row.tenant_id !== null) return tenantScope(row.tenant_id as TenantId);
  throw new SmsKitError("STORAGE_FAILURE", "audit event has an invalid ownership scope", true);
}
function event(row: AuditRow): AuditEvent {
  return { id: row.id, ...scope(row), actorId: row.actor_id, action: row.action, targetType: row.target_type,
    ...(row.target_id === null ? {} : { targetId: row.target_id }), result: row.result,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }), metadata: projectSafeEventMetadata(row.metadata), occurredAt: row.occurred_at };
}

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  async append(input: AuditEvent, tx?: SmsTransaction): Promise<AuditEvent> {
    const { rows } = await db(this.pool, tx).query<AuditRow>(
      `insert into sms_kit.audit_event (id, scope_type, tenant_id, actor_id, action, target_type, target_id, result, error_code, metadata, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) returning ${fields}`,
      [input.id, input.scopeType, scopeTenantId(input), input.actorId, input.action, input.targetType, input.targetId ?? null, input.result, input.errorCode ?? null, JSON.stringify(projectSafeEventMetadata(input.metadata)), input.occurredAt],
    );
    return event(rows[0]!);
  }

  async list(input: Parameters<AuditRepository["list"]>[0], tx?: SmsTransaction): Promise<{ items: readonly AuditEvent[]; total: number }> {
    const client = db(this.pool, tx);
    const [count, items] = await Promise.all([
      client.query<{ total: string }>("select count(*)::text as total from sms_kit.audit_event where scope_type = $1 and tenant_id is not distinct from $2", [input.scope.scopeType, scopeTenantId(input.scope)]),
      client.query<AuditRow>(`select ${fields} from sms_kit.audit_event where scope_type = $1 and tenant_id is not distinct from $2 order by occurred_at desc, id desc limit $3 offset $4`, [input.scope.scopeType, scopeTenantId(input.scope), input.pageSize, (input.page - 1) * input.pageSize]),
    ]);
    return { items: items.rows.map(event), total: Number(count.rows[0]?.total ?? "0") };
  }
}
