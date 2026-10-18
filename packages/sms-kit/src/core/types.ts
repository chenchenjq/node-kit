export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type TenantId = Brand<string, "TenantId">;
export type MessageId = Brand<string, "MessageId">;
export type TemplateId = Brand<string, "TemplateId">;
export type ChallengeId = Brand<string, "ChallengeId">;

/**
 * Every SMS-domain record is owned either by the singleton system scope or by
 * one trusted tenant.  SYSTEM deliberately has no tenantId: callers cannot
 * emulate it with a reserved tenant string.
 */
export type SystemScope = Readonly<{ scopeType: "SYSTEM" }>;
export type TenantScope = Readonly<{ scopeType: "TENANT"; tenantId: TenantId }>;
export type SmsScope = SystemScope | TenantScope;

export const SYSTEM_SCOPE: SystemScope = Object.freeze({ scopeType: "SYSTEM" });

export function tenantScope(tenantId: TenantId): TenantScope {
  return Object.freeze({ scopeType: "TENANT", tenantId });
}

/** Returns null exactly for the system scope, matching persisted tenant_id. */
export function scopeTenantId(scope: SmsScope): TenantId | null {
  return scope.scopeType === "SYSTEM" ? null : scope.tenantId;
}
