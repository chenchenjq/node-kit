import { SmsKitError } from "../../core/errors.js";
import { projectSafeEventMetadata } from "../../ports/runtime.js";
import { scopeTenantId, SYSTEM_SCOPE, tenantScope } from "../../core/types.js";
const fields = "id, scope_type, tenant_id, actor_id, action, target_type, target_id, result, error_code, metadata, occurred_at";
function db(pool, tx) { return tx === undefined ? pool : tx.client; }
function scope(row) {
    if (row.scope_type === "SYSTEM" && row.tenant_id === null)
        return SYSTEM_SCOPE;
    if (row.scope_type === "TENANT" && row.tenant_id !== null)
        return tenantScope(row.tenant_id);
    throw new SmsKitError("STORAGE_FAILURE", "audit event has an invalid ownership scope", true);
}
function event(row) {
    return { id: row.id, ...scope(row), actorId: row.actor_id, action: row.action, targetType: row.target_type,
        ...(row.target_id === null ? {} : { targetId: row.target_id }), result: row.result,
        ...(row.error_code === null ? {} : { errorCode: row.error_code }), metadata: projectSafeEventMetadata(row.metadata), occurredAt: row.occurred_at };
}
export class PgAuditRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async append(input, tx) {
        const { rows } = await db(this.pool, tx).query(`insert into sms_kit.audit_event (id, scope_type, tenant_id, actor_id, action, target_type, target_id, result, error_code, metadata, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) returning ${fields}`, [input.id, input.scopeType, scopeTenantId(input), input.actorId, input.action, input.targetType, input.targetId ?? null, input.result, input.errorCode ?? null, JSON.stringify(projectSafeEventMetadata(input.metadata)), input.occurredAt]);
        return event(rows[0]);
    }
    async list(input, tx) {
        const client = db(this.pool, tx);
        const [count, items] = await Promise.all([
            client.query("select count(*)::text as total from sms_kit.audit_event where scope_type = $1 and tenant_id is not distinct from $2", [input.scope.scopeType, scopeTenantId(input.scope)]),
            client.query(`select ${fields} from sms_kit.audit_event where scope_type = $1 and tenant_id is not distinct from $2 order by occurred_at desc, id desc limit $3 offset $4`, [input.scope.scopeType, scopeTenantId(input.scope), input.pageSize, (input.page - 1) * input.pageSize]),
        ]);
        return { items: items.rows.map(event), total: Number(count.rows[0]?.total ?? "0") };
    }
}
