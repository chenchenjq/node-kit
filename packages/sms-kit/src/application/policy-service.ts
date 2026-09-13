import { SmsKitError } from "../core/errors.js";
import type { VerificationPolicy, VerificationPolicyUpdate } from "../ports/policy.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { TenantId } from "../core/types.js";

const SYSTEM_TENANT_ID = "__system__" as TenantId;

export type PolicyServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  store: SmsStore;
  authorizer: Authorizer<Actor>;
  clock: Clock;
  ids: Pick<IdGenerator, "next">;
}>;

function isIntegerInRange(value: number, lower: number, upper: number): boolean {
  return Number.isSafeInteger(value) && value >= lower && value <= upper;
}

function invalid(field: string): never {
  throw new SmsKitError("CONFIG_INVALID", "invalid verification policy", false, { [field]: ["invalid value"] });
}

/** Validates policy separately from provider configuration and its readiness version. */
export function validateVerificationPolicy(input: VerificationPolicyUpdate): void {
  if (!isIntegerInRange(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER)) invalid("expectedVersion");
  if (!isIntegerInRange(input.otpLength, 4, 8)) invalid("otpLength");
  if (!isIntegerInRange(input.otpTtlSeconds, 60, 900)) invalid("otpTtlSeconds");
  if (!isIntegerInRange(input.otpMaxAttempts, 1, 10)) invalid("otpMaxAttempts");
  if (!isIntegerInRange(input.proofTtlSeconds, 30, 900)) invalid("proofTtlSeconds");
  if (!isIntegerInRange(input.phoneMinIntervalSeconds, 0, 86_400)) invalid("phoneMinIntervalSeconds");
  if (!isIntegerInRange(input.phoneHourlyLimit, 1, 100_000)) invalid("phoneHourlyLimit");
  if (!isIntegerInRange(input.phoneDailyLimit, input.phoneHourlyLimit, 1_000_000)) invalid("phoneDailyLimit");
  if (!isIntegerInRange(input.ipWindowSeconds, 1, 86_400)) invalid("ipWindowSeconds");
  if (!isIntegerInRange(input.ipWindowLimit, 1, 1_000_000)) invalid("ipWindowLimit");
  if (input.systemDailyBudget !== null && !isIntegerInRange(input.systemDailyBudget, 1, 10_000_000)) invalid("systemDailyBudget");
  if (input.circuitOpen && (typeof input.circuitReason !== "string" || input.circuitReason.trim().length === 0)) invalid("circuitReason");
  if (!input.circuitOpen && input.circuitReason !== undefined) invalid("circuitReason");
}

export class PolicyService<Actor extends AuthorizationActor = AuthorizationActor> {
  constructor(private readonly dependencies: PolicyServiceDependencies<Actor>) {}

  async get(actor: Actor): Promise<VerificationPolicy> {
    await this.dependencies.authorizer.assert(actor, "config.read");
    return this.dependencies.store.policy.get();
  }

  async update(actor: Actor, input: VerificationPolicyUpdate): Promise<VerificationPolicy> {
    await this.dependencies.authorizer.assert(actor, "config.write");
    validateVerificationPolicy(input);
    return this.dependencies.store.transaction(async (tx) => {
      const updated = await this.dependencies.store.policy.update(input, tx);
      await this.dependencies.store.audits.append({
        id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
        action: "policy.update", targetType: "verification_policy", result: "succeeded", occurredAt: this.dependencies.clock.now(),
      }, tx);
      return updated;
    });
  }
}
