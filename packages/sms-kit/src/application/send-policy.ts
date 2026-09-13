import { SmsKitError } from "../core/errors.js";
import type { TenantId } from "../core/types.js";
import type { VerificationPolicy } from "../ports/policy.js";
import type { RateLimitRepository, SmsTransaction } from "../ports/store.js";

function windowStart(now: Date, seconds: number): Date {
  return new Date(Math.floor(now.getTime() / (seconds * 1_000)) * seconds * 1_000);
}

async function count(
  rateLimits: RateLimitRepository, tenantId: TenantId, scopeHash: string, now: Date, seconds: number, tx: SmsTransaction,
): Promise<number> {
  const start = windowStart(now, seconds);
  return rateLimits.increment({ tenantId, scope: "phone_purpose", scopeHash, windowStart: start, windowSeconds: seconds, expiresAt: new Date(start.getTime() + seconds * 1_000) }, tx);
}

/** Applies tenant-scoped phone limits inside the same transaction as dispatch reservation. */
export async function enforcePhoneSendPolicy(input: Readonly<{
  policy: VerificationPolicy;
  rateLimits: RateLimitRepository;
  tenantId: TenantId;
  phoneHash: string;
  purpose: string;
  now: Date;
  tx: SmsTransaction;
}>): Promise<void> {
  if (input.policy.circuitOpen) throw new SmsKitError("CIRCUIT_OPEN", "sending circuit is open");
  const scopeHash = `${input.phoneHash}:${input.purpose}`;
  if (input.policy.phoneMinIntervalSeconds > 0 && await count(input.rateLimits, input.tenantId, scopeHash, input.now, input.policy.phoneMinIntervalSeconds, input.tx) > 1) {
    throw new SmsKitError("RATE_LIMITED", "phone send interval is limited");
  }
  if (await count(input.rateLimits, input.tenantId, scopeHash, input.now, 60 * 60, input.tx) > input.policy.phoneHourlyLimit) {
    throw new SmsKitError("RATE_LIMITED", "phone hourly send limit is exceeded");
  }
  if (await count(input.rateLimits, input.tenantId, scopeHash, input.now, 24 * 60 * 60, input.tx) > input.policy.phoneDailyLimit) {
    throw new SmsKitError("RATE_LIMITED", "phone daily send limit is exceeded");
  }
}
