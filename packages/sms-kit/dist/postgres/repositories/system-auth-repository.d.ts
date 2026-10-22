import type { Pool } from "pg";
import type { SystemAuthChallenge, SystemAuthReconciliationLease, SystemAuthRepository } from "../../ports/system-auth.js";
import type { SmsTransaction } from "../../ports/store.js";
/** Persistence boundary for singleton login and password-reset SMS only. */
export declare class PgSystemAuthRepository implements SystemAuthRepository {
    private readonly pool;
    constructor(pool: Pool);
    getChallengeByIdempotency(input: Parameters<SystemAuthRepository["getChallengeByIdempotency"]>[0], tx?: SmsTransaction): Promise<SystemAuthChallenge | undefined>;
    createChallenge(input: Parameters<SystemAuthRepository["createChallenge"]>[0], tx: SmsTransaction): Promise<SystemAuthChallenge>;
    invalidateActiveChallenges(input: Parameters<SystemAuthRepository["invalidateActiveChallenges"]>[0], tx: SmsTransaction): Promise<void>;
    getChallengeForUpdate(input: Parameters<SystemAuthRepository["getChallengeForUpdate"]>[0], tx: SmsTransaction): Promise<SystemAuthChallenge | undefined>;
    incrementChallengeAttempts(input: Parameters<SystemAuthRepository["incrementChallengeAttempts"]>[0], tx: SmsTransaction): Promise<SystemAuthChallenge>;
    verifyChallenge(input: Parameters<SystemAuthRepository["verifyChallenge"]>[0], tx: SmsTransaction): Promise<SystemAuthChallenge>;
    consumeProof(input: Parameters<SystemAuthRepository["consumeProof"]>[0], tx: SmsTransaction): Promise<"consumed" | "replay" | "invalid">;
    markChallengeDelivery(input: Parameters<SystemAuthRepository["markChallengeDelivery"]>[0], tx: SmsTransaction): Promise<SystemAuthChallenge>;
    createMessage(input: Parameters<SystemAuthRepository["createMessage"]>[0], tx: SmsTransaction): Promise<{
        id: import("../../core/types.js").MessageId;
        created: boolean;
    }>;
    startAttempt(input: Parameters<SystemAuthRepository["startAttempt"]>[0], tx: SmsTransaction): Promise<string>;
    completeAttempt(input: Parameters<SystemAuthRepository["completeAttempt"]>[0], tx: SmsTransaction): Promise<void>;
    recoverAbandoned(input: Parameters<SystemAuthRepository["recoverAbandoned"]>[0], tx: SmsTransaction): Promise<number>;
    applyReceipt(input: Parameters<SystemAuthRepository["applyReceipt"]>[0], tx: SmsTransaction): Promise<Readonly<{
        matched: boolean;
        terminalConflict: boolean;
    }>>;
    scheduleReconciliation(input: Parameters<SystemAuthRepository["scheduleReconciliation"]>[0], tx: SmsTransaction): Promise<void>;
    leaseReconciliation(input: Parameters<SystemAuthRepository["leaseReconciliation"]>[0]): Promise<readonly SystemAuthReconciliationLease[]>;
    finishTerminalReconciliation(input: Parameters<SystemAuthRepository["finishTerminalReconciliation"]>[0], tx: SmsTransaction): Promise<void>;
    completeQueryReconciliation(input: Parameters<SystemAuthRepository["completeQueryReconciliation"]>[0], tx: SmsTransaction): Promise<void>;
    rescheduleReconciliation(input: Parameters<SystemAuthRepository["rescheduleReconciliation"]>[0]): Promise<void>;
    finalizeUnknownReconciliation(input: Parameters<SystemAuthRepository["finalizeUnknownReconciliation"]>[0], tx: SmsTransaction): Promise<void>;
    markMessageAcceptance(input: Parameters<SystemAuthRepository["markMessageAcceptance"]>[0], tx: SmsTransaction): Promise<void>;
}
