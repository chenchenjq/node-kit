import type { Pool } from "pg";
import type { Challenge, ChallengeRepository, ConsumeProofResult, SmsTransaction } from "../../ports/store.js";
export declare class PgChallengeRepository implements ChallengeRepository {
    private readonly pool;
    constructor(pool: Pool);
    create(input: Parameters<ChallengeRepository["create"]>[0], tx?: SmsTransaction): Promise<Challenge>;
    get(input: Parameters<ChallengeRepository["get"]>[0], tx?: SmsTransaction): Promise<Challenge | undefined>;
    getByIdempotency(input: Parameters<ChallengeRepository["getByIdempotency"]>[0], tx?: SmsTransaction): Promise<Challenge | undefined>;
    invalidateActiveForSubjectAction(input: Parameters<ChallengeRepository["invalidateActiveForSubjectAction"]>[0], tx: SmsTransaction): Promise<number>;
    getForUpdate(input: Parameters<ChallengeRepository["getForUpdate"]>[0], tx: SmsTransaction): Promise<Challenge | undefined>;
    incrementAttempts(input: Parameters<ChallengeRepository["incrementAttempts"]>[0], tx: SmsTransaction): Promise<Challenge>;
    verify(input: Parameters<ChallengeRepository["verify"]>[0], tx: SmsTransaction): Promise<Challenge>;
    markDeliveryAcceptance(input: Parameters<ChallengeRepository["markDeliveryAcceptance"]>[0], tx?: SmsTransaction): Promise<Challenge>;
    invalidate(input: Parameters<ChallengeRepository["invalidate"]>[0], tx?: SmsTransaction): Promise<Challenge>;
    consumeProof(input: Parameters<ChallengeRepository["consumeProof"]>[0], tx: SmsTransaction): Promise<ConsumeProofResult>;
}
