import { type ChallengeId } from "../core/types.js";
import { type SmsProvider } from "../ports/provider.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { OtpHasher, PhoneNumberProtector } from "../ports/security.js";
import type { SmsStore, SmsTransaction } from "../ports/store.js";
import type { SystemAuthAction, SystemAuthRepository } from "../ports/system-auth.js";
import { OtpGenerator } from "../security/otp-generator.js";
export type IssueSystemAuthChallengeInput = Readonly<{
    subjectId: string;
    action: SystemAuthAction;
    phone: string;
    ipAddress?: string;
    idempotencyKey: string;
}>;
export type VerifySystemAuthChallengeInput = Readonly<{
    subjectId: string;
    action: SystemAuthAction;
    challengeId: ChallengeId;
    code: string;
}>;
export type IssueSystemAuthChallengeResult = Readonly<{
    id: ChallengeId;
    expiresAt: Date;
}>;
export type VerifySystemAuthChallengeResult = Readonly<{
    proof: string;
    proofExpiresAt: Date;
}>;
export type ConsumeSystemAuthProofInput = Readonly<{
    subjectId: string;
    action: SystemAuthAction;
    proof: string;
    consumptionKey: string;
}>;
export type SystemAuthSmsServiceDependencies = Readonly<{
    store: Pick<SmsStore, "transaction" | "config" | "resources" | "policy" | "rateLimits" | "audits">;
    repository: SystemAuthRepository;
    provider: SmsProvider;
    phoneProtector: Pick<PhoneNumberProtector, "protect">;
    hasher: OtpHasher;
    clock: Clock;
    ids: Pick<IdGenerator, "next" | "messageId">;
    providerTimeoutMs: number;
    otpGenerator?: Pick<OtpGenerator, "generate">;
}>;
/** Singleton login/password-reset SMS flow; it never accepts or invents a tenant id. */
export declare class SystemAuthSmsService {
    private readonly dependencies;
    private readonly otpGenerator;
    constructor(dependencies: SystemAuthSmsServiceDependencies);
    issue(input: IssueSystemAuthChallengeInput): Promise<IssueSystemAuthChallengeResult>;
    verify(input: VerifySystemAuthChallengeInput): Promise<VerifySystemAuthChallengeResult>;
    /** Caller owns the transaction. Commit a false result to retain failed-attempt accounting. */
    verifyAndConsume(input: VerifySystemAuthChallengeInput & {
        consumptionKey: string;
    }, tx: SmsTransaction): Promise<boolean>;
    private verifyWithin;
    consumeProof(input: ConsumeSystemAuthProofInput, tx?: SmsTransaction): Promise<"consumed" | "replay">;
    private assertPolicy;
    private enforceIpLimit;
    private requireTemplate;
}
