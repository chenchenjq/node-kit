import { SmsKitError } from "../core/errors.js";
import { SYSTEM_SCOPE } from "../core/types.js";
import { executeAdminOperation } from "./admin-operation.js";
function isIntegerInRange(value, lower, upper) {
    return Number.isSafeInteger(value) && value >= lower && value <= upper;
}
function invalid(field) {
    throw new SmsKitError("CONFIG_INVALID", "invalid verification policy", false, { [field]: ["invalid value"] });
}
/** Validates policy separately from provider configuration and its readiness version. */
export function validateVerificationPolicy(input) {
    if (!isIntegerInRange(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER))
        invalid("expectedVersion");
    if (!isIntegerInRange(input.otpLength, 4, 8))
        invalid("otpLength");
    if (!isIntegerInRange(input.otpTtlSeconds, 60, 900))
        invalid("otpTtlSeconds");
    if (!isIntegerInRange(input.otpMaxAttempts, 1, 10))
        invalid("otpMaxAttempts");
    if (!isIntegerInRange(input.proofTtlSeconds, 30, 900))
        invalid("proofTtlSeconds");
    if (!isIntegerInRange(input.phoneMinIntervalSeconds, 1, 3_600))
        invalid("phoneMinIntervalSeconds");
    if (!isIntegerInRange(input.phoneHourlyLimit, 1, 2_147_483_647))
        invalid("phoneHourlyLimit");
    if (!isIntegerInRange(input.phoneDailyLimit, input.phoneHourlyLimit, 2_147_483_647))
        invalid("phoneDailyLimit");
    if (!isIntegerInRange(input.ipWindowSeconds, 60, 86_400))
        invalid("ipWindowSeconds");
    if (!isIntegerInRange(input.ipWindowLimit, 1, 2_147_483_647))
        invalid("ipWindowLimit");
    if (input.systemDailyBudget !== null && !isIntegerInRange(input.systemDailyBudget, 1, 2_147_483_647))
        invalid("systemDailyBudget");
    if (typeof input.circuitOpen !== "boolean")
        invalid("circuitOpen");
    if (input.circuitOpen && (typeof input.circuitReason !== "string" || input.circuitReason.trim().length === 0))
        invalid("circuitReason");
    if (!input.circuitOpen && input.circuitReason !== undefined)
        invalid("circuitReason");
}
function policyUpdateFields(value) {
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
    };
}
function policyValue(value) {
    const { expectedVersion, ...fields } = policyUpdateFields(value);
    return { version: expectedVersion, ...fields };
}
/** Snapshots are allow-listed, so a durable replay cannot surface storage-only fields. */
function policySnapshot(value) {
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
function snapshotNumber(snapshot, key) {
    const value = snapshot[key];
    if (typeof value !== "number")
        throw new TypeError(`invalid ${key}`);
    return value;
}
function policyFromSnapshot(snapshot) {
    if (snapshot.kind !== "verification-policy" || typeof snapshot.circuitOpen !== "boolean") {
        throw new TypeError("invalid verification policy snapshot");
    }
    const budget = snapshot.systemDailyBudget;
    if (budget !== null && typeof budget !== "number")
        throw new TypeError("invalid systemDailyBudget");
    const reason = snapshot.circuitReason;
    if (reason !== undefined && typeof reason !== "string")
        throw new TypeError("invalid circuitReason");
    const input = {
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
export class PolicyService {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async get(actor) {
        await this.dependencies.authorizer.assert(actor, "config.read");
        return this.dependencies.store.policy.get();
    }
    async update(actor, input) {
        await this.dependencies.authorizer.assert(actor, "config.write");
        validateVerificationPolicy(input);
        return this.dependencies.store.transaction((tx) => this.updateInTransaction(actor, input, tx));
    }
    /**
     * Applies an admin policy patch with tenant-scoped durable replay.  The
     * policy row itself remains global and keeps its own optimistic version;
     * provider configuration is intentionally never read or saved here.
     */
    async patch(actor, input) {
        await this.dependencies.authorizer.assert(actor, "config.write");
        if (input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 512) {
            throw new SmsKitError("CONFIG_INVALID", "invalid verification policy");
        }
        const update = policyUpdateFields(input);
        validateVerificationPolicy(update);
        const execution = await executeAdminOperation({
            store: this.dependencies.store,
            scope: SYSTEM_SCOPE,
            operation: "policy.update",
            idempotencyKey: input.idempotencyKey,
            request: update,
            encode: policySnapshot,
            decode: policyFromSnapshot,
            work: (tx) => this.updateInTransaction(actor, update, tx),
        });
        return execution.value;
    }
    async updateInTransaction(actor, input, tx) {
        // A PATCH may be the first policy operation after migration. Initialize
        // the singleton in the same transaction before applying its version fence.
        await this.dependencies.store.policy.get(tx);
        const updated = await this.dependencies.store.policy.update(input, tx);
        await this.dependencies.store.audits.append({
            id: this.dependencies.ids.next(), ...SYSTEM_SCOPE, actorId: actor.id,
            action: "policy.update", targetType: "verification_policy", result: "succeeded", occurredAt: this.dependencies.clock.now(),
        }, tx);
        return updated;
    }
}
