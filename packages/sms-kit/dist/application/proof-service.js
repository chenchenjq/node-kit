import { SmsKitError } from "../core/errors.js";
function requireNonEmpty(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new SmsKitError("CONFIG_INVALID", `${field} is required`);
    }
}
function requireTrustedTenant(tenantId) {
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
        throw new SmsKitError("PERMISSION_DENIED", "trusted tenant is required");
    }
}
/** Matches the proof binding created during ChallengeService.verify without retaining plaintext. */
function proofBinding(input) {
    return `${input.tenantId}\u0000${input.subjectId}\u0000${input.action}\u0000${input.proof}`;
}
function invalidProof(result) {
    const message = result.consumed
        ? "proof cannot be consumed"
        : result.reason === "expired"
            ? "proof has expired"
            : "proof has already been consumed";
    throw new SmsKitError("PROOF_INVALID", message);
}
/**
 * Consumes a short-lived proof by its tenant/subject/action-bound keyed hash.
 *
 * Without a transaction this owns a short SMS-store transaction. For a shared database,
 * pass the host transaction so the proof and business write commit or roll back together.
 */
export class ProofService {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async consume(input, tx) {
        requireTrustedTenant(input.tenantId);
        requireNonEmpty(input.proof, "proof");
        requireNonEmpty(input.subjectId, "subject");
        requireNonEmpty(input.action, "action");
        requireNonEmpty(input.consumptionKey, "consumption key");
        if (tx === undefined) {
            return this.dependencies.store.transaction((ownedTx) => this.consume(input, ownedTx));
        }
        const result = await this.dependencies.store.challenges.consumeProof({
            tenantId: input.tenantId,
            proof: await this.dependencies.hasher.hash(proofBinding(input)),
            subjectId: input.subjectId,
            action: input.action,
            consumptionKey: input.consumptionKey,
            now: () => this.dependencies.clock.now(),
        }, tx);
        if (!result.consumed)
            return invalidProof(result);
        return result;
    }
}
