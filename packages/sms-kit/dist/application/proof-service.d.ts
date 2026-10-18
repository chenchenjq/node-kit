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
/**
 * Consumes a short-lived proof by its tenant/subject/action-bound keyed hash.
 *
 * Without a transaction this owns a short SMS-store transaction. For a shared database,
 * pass the host transaction so the proof and business write commit or roll back together.
 */
export declare class ProofService {
    private readonly dependencies;
    constructor(dependencies: ProofServiceDependencies);
    consume(input: ConsumeProofInput, tx?: SmsTransaction): Promise<Extract<ConsumeProofResult, {
        consumed: true;
    }>>;
}
