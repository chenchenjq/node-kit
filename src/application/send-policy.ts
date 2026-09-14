import { SmsKitError } from "../core/errors.js";
import type { TenantId } from "../core/types.js";
import type { VerificationPolicy } from "../ports/policy.js";
import type { RateLimitRepository, SmsTransaction } from "../ports/store.js";

const maximumPhoneCooldownSeconds = 3_600;

async function countTrailing(
  rateLimits: RateLimitRepository, tenantId: TenantId, scopeHash: string, now: Date, seconds: number, tx: SmsTransaction,
): Promise<number> {
  // The advisory lock held by the caller serializes this event insert and its
  // trailing-window read. Equal timestamps safely coalesce into one counted row.
  await rateLimits.increment({
    tenantId,
    scope: "phone_purpose",
    scopeHash,
    windowStart: now,
    windowSeconds: seconds,
    expiresAt: new Date(now.getTime() + seconds * 1_000),
  }, tx);
  return rateLimits.countSince({
    tenantId,
    scope: "phone_purpose",
    scopeHash,
    since: new Date(now.getTime() - seconds * 1_000),
  }, tx);
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
  const base = `${input.phoneHash}:${input.purpose}`;
  // This must precede both the cooldown read and event insert. Transaction-scoped
  // advisory locking serializes exactly one trusted tenant/phone/purpose stream.
  await input.rateLimits.lock({ tenantId: input.tenantId, scopeHash: base }, input.tx);
  if (input.policy.phoneMinIntervalSeconds > 0) {
    const cooldown = `cooldown:${base}`;
    // Store each event independently so the boundary is sliding, not epoch aligned.
    // Retain it for the largest allowed interval: a later policy increase must
    // still see sends recorded under a shorter interval after retention runs.
    await input.rateLimits.increment({ tenantId: input.tenantId, scope: "phone_purpose", scopeHash: cooldown, windowStart: input.now, windowSeconds: 1, expiresAt: new Date(input.now.getTime() + maximumPhoneCooldownSeconds * 1_000) }, input.tx);
    if (await input.rateLimits.countSince({ tenantId: input.tenantId, scope: "phone_purpose", scopeHash: cooldown, since: new Date(input.now.getTime() - input.policy.phoneMinIntervalSeconds * 1_000) }, input.tx) > 1) {
      throw new SmsKitError("RATE_LIMITED", "phone send interval is limited");
    }
  }
  if (await countTrailing(input.rateLimits, input.tenantId, `hourly:${base}`, input.now, 60 * 60, input.tx) > input.policy.phoneHourlyLimit) {
    throw new SmsKitError("RATE_LIMITED", "phone hourly send limit is exceeded");
  }
  if (await countTrailing(input.rateLimits, input.tenantId, `daily:${base}`, input.now, 24 * 60 * 60, input.tx) > input.policy.phoneDailyLimit) {
    throw new SmsKitError("RATE_LIMITED", "phone daily send limit is exceeded");
  }
}
