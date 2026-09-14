import { SmsKitError } from "../core/errors.js";
import type { TenantId } from "../core/types.js";
import type { Clock } from "../ports/runtime.js";
import type { OtpHasher } from "../ports/security.js";
import type { ConsumeProofResult, SmsStore, SmsTransaction } from "../ports/store.js";

export type ConsumeProofInput = Readonly<{
  tenantId: TenantId;
  proof: string;
  subjectId: string;
  action: string;
  /**
   * The host operation's idempotency key. For cross-database compensation, the downstream
   * operation must use this exact value as its idempotency key before a replay is accepted.
   */
  consumptionKey: string;
}>;

export type ProofServiceDependencies = Readonly<{
  store: Pick<SmsStore, "transaction" | "challenges">;
  hasher: Pick<OtpHasher, "hash">;
  clock: Clock;
}>;

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SmsKitError("CONFIG_INVALID", `${field} is required`);
  }
}

function requireTrustedTenant(tenantId: TenantId): void {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new SmsKitError("PERMISSION_DENIED", "trusted tenant is required");
  }
}

/** Matches the proof binding created during ChallengeService.verify without retaining plaintext. */
function proofBinding(input: ConsumeProofInput): string {
  return `${input.tenantId}\u0000${input.subjectId}\u0000${input.action}\u0000${input.proof}`;
}

function invalidProof(result: ConsumeProofResult): never {
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
  constructor(private readonly dependencies: ProofServiceDependencies) {}

  async consume(input: ConsumeProofInput, tx?: SmsTransaction): Promise<Extract<ConsumeProofResult, { consumed: true }>> {
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
    if (!result.consumed) return invalidProof(result);
    return result;
  }
}
