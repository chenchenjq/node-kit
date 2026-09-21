import { SmsKitError } from "../core/errors.js";
import type { VerificationPolicy, VerificationPolicyUpdate } from "../ports/policy.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import type { SmsStore, SmsTransaction } from "../ports/store.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { TenantId } from "../core/types.js";
import { executeAdminOperation } from "./admin-operation.js";

const SYSTEM_TENANT_ID = "__system__" as TenantId;

export type PolicyServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  store: SmsStore;
  authorizer: Authorizer<Actor>;
  clock: Clock;
  ids: Pick<IdGenerator, "next">;
}>;

/** Public admin writes retain a policy-specific version and durable replay key. */
export type PatchVerificationPolicyInput = VerificationPolicyUpdate & Readonly<{
  idempotencyKey: string;
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
  if (!isIntegerInRange(input.phoneMinIntervalSeconds, 1, 3_600)) invalid("phoneMinIntervalSeconds");
  if (!isIntegerInRange(input.phoneHourlyLimit, 1, 2_147_483_647)) invalid("phoneHourlyLimit");
  if (!isIntegerInRange(input.phoneDailyLimit, input.phoneHourlyLimit, 2_147_483_647)) invalid("phoneDailyLimit");
  if (!isIntegerInRange(input.ipWindowSeconds, 60, 86_400)) invalid("ipWindowSeconds");
  if (!isIntegerInRange(input.ipWindowLimit, 1, 2_147_483_647)) invalid("ipWindowLimit");
  if (input.systemDailyBudget !== null && !isIntegerInRange(input.systemDailyBudget, 1, 2_147_483_647)) invalid("systemDailyBudget");
  if (typeof input.circuitOpen !== "boolean") invalid("circuitOpen");
  if (input.circuitOpen && (typeof input.circuitReason !== "string" || input.circuitReason.trim().length === 0)) invalid("circuitReason");
  if (!input.circuitOpen && input.circuitReason !== undefined) invalid("circuitReason");
}

function policyUpdateFields(value: VerificationPolicyUpdate) {
  return {
    expectedVersion: value.expectedVersion,
    otpLength: value.otpLength,
    otpTtlSeconds: value.otpTtlSeconds,
    otpMaxAttempts: value.otpMaxAttempts,
    proofTtlSeconds: value.proofTtlSeconds,
    phoneMinIntervalSeconds: value.phoneMinIntervalSeconds,
    phoneHourlyLimit: value.phoneHourlyLimit,
    phoneDailyLimit: value.phoneDailyLimit,
    ipWindowSeconds: value.ipWindowSeconds,
    ipWindowLimit: value.ipWindowLimit,
    systemDailyBudget: value.systemDailyBudget,
    circuitOpen: value.circuitOpen,
    ...(value.circuitReason === undefined ? {} : { circuitReason: value.circuitReason }),
  } satisfies VerificationPolicyUpdate;
}

function policyValue(value: VerificationPolicyUpdate): VerificationPolicy {
  const { expectedVersion, ...fields } = policyUpdateFields(value);
  return { version: expectedVersion, ...fields };
}

/** Snapshots are allow-listed, so a durable replay cannot surface storage-only fields. */
function policySnapshot(value: VerificationPolicy): Readonly<Record<string, unknown>> {
  return {
    kind: "verification-policy",
    version: value.version,
    otpLength: value.otpLength,
    otpTtlSeconds: value.otpTtlSeconds,
    otpMaxAttempts: value.otpMaxAttempts,
    proofTtlSeconds: value.proofTtlSeconds,
    phoneMinIntervalSeconds: value.phoneMinIntervalSeconds,
    phoneHourlyLimit: value.phoneHourlyLimit,
    phoneDailyLimit: value.phoneDailyLimit,
    ipWindowSeconds: value.ipWindowSeconds,
    ipWindowLimit: value.ipWindowLimit,
    systemDailyBudget: value.systemDailyBudget,
    circuitOpen: value.circuitOpen,
    ...(value.circuitReason === undefined ? {} : { circuitReason: value.circuitReason }),
  };
}

function snapshotNumber(snapshot: Readonly<Record<string, unknown>>, key: string): number {
  const value = snapshot[key];
  if (typeof value !== "number") throw new TypeError(`invalid ${key}`);
  return value;
}

function policyFromSnapshot(snapshot: Readonly<Record<string, unknown>>): VerificationPolicy {
  if (snapshot.kind !== "verification-policy" || typeof snapshot.circuitOpen !== "boolean") {
    throw new TypeError("invalid verification policy snapshot");
  }
  const budget = snapshot.systemDailyBudget;
  if (budget !== null && typeof budget !== "number") throw new TypeError("invalid systemDailyBudget");
  const reason = snapshot.circuitReason;
  if (reason !== undefined && typeof reason !== "string") throw new TypeError("invalid circuitReason");
  const input: VerificationPolicyUpdate = {
    expectedVersion: snapshotNumber(snapshot, "version"),
    otpLength: snapshotNumber(snapshot, "otpLength"),
    otpTtlSeconds: snapshotNumber(snapshot, "otpTtlSeconds"),
    otpMaxAttempts: snapshotNumber(snapshot, "otpMaxAttempts"),
    proofTtlSeconds: snapshotNumber(snapshot, "proofTtlSeconds"),
    phoneMinIntervalSeconds: snapshotNumber(snapshot, "phoneMinIntervalSeconds"),
    phoneHourlyLimit: snapshotNumber(snapshot, "phoneHourlyLimit"),
    phoneDailyLimit: snapshotNumber(snapshot, "phoneDailyLimit"),
    ipWindowSeconds: snapshotNumber(snapshot, "ipWindowSeconds"),
    ipWindowLimit: snapshotNumber(snapshot, "ipWindowLimit"),
    systemDailyBudget: budget,
    circuitOpen: snapshot.circuitOpen,
    ...(reason === undefined ? {} : { circuitReason: reason }),
  };
  validateVerificationPolicy(input);
  return policyValue(input);
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
    return this.dependencies.store.transaction((tx) => this.updateInTransaction(actor, input, tx));
  }

  /**
   * Applies an admin policy patch with tenant-scoped durable replay.  The
   * policy row itself remains global and keeps its own optimistic version;
   * provider configuration is intentionally never read or saved here.
   */
  async patch(actor: Actor, input: PatchVerificationPolicyInput): Promise<VerificationPolicy> {
    await this.dependencies.authorizer.assert(actor, "config.write");
    if (input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 512) {
      throw new SmsKitError("CONFIG_INVALID", "invalid verification policy");
    }
    const update = policyUpdateFields(input);
    validateVerificationPolicy(update);
    const execution = await executeAdminOperation({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "policy.update",
      idempotencyKey: input.idempotencyKey,
      request: update,
      encode: policySnapshot,
      decode: policyFromSnapshot,
      work: (tx) => this.updateInTransaction(actor, update, tx),
    });
    return execution.value;
  }

  private async updateInTransaction(actor: Actor, input: VerificationPolicyUpdate, tx: SmsTransaction): Promise<VerificationPolicy> {
    // A PATCH may be the first policy operation after migration. Initialize
    // the singleton in the same transaction before applying its version fence.
    await this.dependencies.store.policy.get(tx);
    const updated = await this.dependencies.store.policy.update(input, tx);
    await this.dependencies.store.audits.append({
      id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
      action: "policy.update", targetType: "verification_policy", result: "succeeded", occurredAt: this.dependencies.clock.now(),
    }, tx);
    return updated;
  }
}
