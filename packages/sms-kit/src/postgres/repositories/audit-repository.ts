import type { Pool, PoolClient } from "pg";

import type { AuditEvent, AuditRepository, SmsTransaction } from "../../ports/store.js";
import { projectSafeEventMetadata, type SafeEventMetadata } from "../../ports/runtime.js";
import type { PgSmsTransaction } from "../transaction.js";

type AuditRow = { id: string; tenant_id: string; actor_id: string; action: string; target_type: string; target_id: string | null; result: AuditEvent["result"]; error_code: string | null; metadata: unknown; occurred_at: Date };
const fields = "id, tenant_id, actor_id, action, target_type, target_id, result, error_code, metadata, occurred_at";
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function event(row: AuditRow): AuditEvent {
  return { id: row.id, tenantId: row.tenant_id as AuditEvent["tenantId"], actorId: row.actor_id, action: row.action, targetType: row.target_type,
    ...(row.target_id === null ? {} : { targetId: row.target_id }), result: row.result,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }), metadata: projectSafeEventMetadata(row.metadata), occurredAt: row.occurred_at };
}

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  async append(input: AuditEvent, tx?: SmsTransaction): Promise<AuditEvent> {
    const { rows } = await db(this.pool, tx).query<AuditRow>(
      `insert into sms_kit.audit_event (id, tenant_id, actor_id, action, target_type, target_id, result, error_code, metadata, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) returning ${fields}`,
      [input.id, input.tenantId, input.actorId, input.action, input.targetType, input.targetId ?? null, input.result, input.errorCode ?? null, JSON.stringify(projectSafeEventMetadata(input.metadata)), input.occurredAt],
    );
    return event(rows[0]!);
  }

  async list(input: Parameters<AuditRepository["list"]>[0], tx?: SmsTransaction): Promise<{ items: readonly AuditEvent[]; total: number }> {
    const client = db(this.pool, tx);
    const [count, items] = await Promise.all([
      client.query<{ total: string }>("select count(*)::text as total from sms_kit.audit_event where tenant_id = $1", [input.tenantId]),
      client.query<AuditRow>(`select ${fields} from sms_kit.audit_event where tenant_id = $1 order by occurred_at desc, id desc limit $2 offset $3`, [input.tenantId, input.pageSize, (input.page - 1) * input.pageSize]),
    ]);
    return { items: items.rows.map(event), total: Number(count.rows[0]?.total ?? "0") };
  }
}
