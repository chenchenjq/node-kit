export const SYSTEM_SCOPE = Object.freeze({ scopeType: "SYSTEM" });
export function tenantScope(tenantId) {
    return Object.freeze({ scopeType: "TENANT", tenantId });
}
/** Returns null exactly for the system scope, matching persisted tenant_id. */
export function scopeTenantId(scope) {
    return scope.scopeType === "SYSTEM" ? null : scope.tenantId;
}
