import { type ChallengeId, type TenantId } from "../core/types.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { OtpHasher, PhoneNumberProtector } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";
import { OtpGenerator } from "../security/otp-generator.js";
import { SendService } from "./send-service.js";
export type IssueChallengeInput = Readonly<{
    tenantId: TenantId;
    subjectId: string;
    action: "password.change" | "step.up" | "login.authenticate" | "password.reset";
    phone: string;
    ipAddress?: string;
    idempotencyKey: string;
}>;
export type VerifyChallengeInput = Readonly<{
    tenantId: TenantId;
    challengeId: ChallengeId;
    code: string;
}>;
export type IssueChallengeResult = Readonly<{
    id: ChallengeId;
    expiresAt: Date;
}>;
export type VerifyChallengeResult = Readonly<{
    proof: string;
    proofExpiresAt: Date;
}>;
export type ChallengeServiceDependencies = Readonly<{
    store: Pick<SmsStore, "transaction" | "challenges" | "rateLimits" | "policy">;
    sendService: Pick<SendService, "sendOtpNow">;
    phoneProtector: Pick<PhoneNumberProtector, "protect">;
    hasher: OtpHasher;
    clock: Clock;
    ids: Pick<IdGenerator, "next">;
    otpGenerator?: Pick<OtpGenerator, "generate">;
    /** Bounds a replay's wait for the original direct-dispatch owner; timeout is recovered as acceptance-unknown. */
    pendingReplayWaitMs?: number;
}>;
/** Issues one direct-delivery OTP challenge and verifies it under a transaction-scoped row lock. */
export declare class ChallengeService {
    private readonly dependencies;
    private readonly otpGenerator;
    private readonly pendingReplayWaitMs;
    constructor(dependencies: ChallengeServiceDependencies);
    issue(input: IssueChallengeInput): Promise<IssueChallengeResult>;
    /**
     * The first caller owns network dispatch. Replays never issue another request: they poll the
     * persisted acceptance state without a transaction lock, then atomically turn a stale pending
     * dispatch into acceptance-unknown after the bounded recovery wait.
     */
    private waitForDirectOutcome;
    verify(input: VerifyChallengeInput): Promise<VerifyChallengeResult>;
    private enforceIssuePolicy;
}
