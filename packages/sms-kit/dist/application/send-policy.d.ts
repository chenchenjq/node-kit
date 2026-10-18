import type { SmsScope } from "../core/types.js";
import type { VerificationPolicy } from "../ports/policy.js";
import type { RateLimitRepository, SmsTransaction } from "../ports/store.js";
/** Applies owner-scoped phone limits inside the same transaction as dispatch reservation. */
export declare function enforcePhoneSendPolicy(input: Readonly<{
    policy: VerificationPolicy;
    rateLimits: RateLimitRepository;
    ownership: SmsScope;
    phoneHash: string;
    purpose: string;
    now: Date;
    tx: SmsTransaction;
}>): Promise<void>;
