import { SmsKitError } from "../core/errors.js";
const maximumPhoneCooldownSeconds = 3_600;
async function countTrailing(rateLimits, ownership, scopeHash, now, seconds, tx) {
    // The advisory lock held by the caller serializes this event insert and its
    // trailing-window read. Equal timestamps safely coalesce into one counted row.
    await rateLimits.increment({
        ownership,
        scope: "phone_purpose",
        scopeHash,
        windowStart: now,
        windowSeconds: seconds,
        expiresAt: new Date(now.getTime() + seconds * 1_000),
    }, tx);
    return rateLimits.countSince({
        ownership,
        scope: "phone_purpose",
        scopeHash,
        since: new Date(now.getTime() - seconds * 1_000),
    }, tx);
}
/** Applies owner-scoped phone limits inside the same transaction as dispatch reservation. */
export async function enforcePhoneSendPolicy(input) {
    if (input.policy.circuitOpen)
        throw new SmsKitError("CIRCUIT_OPEN", "sending circuit is open");
    const base = `${input.phoneHash}:${input.purpose}`;
    // This must precede both the cooldown read and event insert. Transaction-scoped
    // advisory locking serializes exactly one owner/phone/purpose stream.
    await input.rateLimits.lock({ ownership: input.ownership, scopeHash: base }, input.tx);
    if (input.policy.phoneMinIntervalSeconds > 0) {
        const cooldown = `cooldown:${base}`;
        // Store each event independently so the boundary is sliding, not epoch aligned.
        // Retain it for the largest allowed interval: a later policy increase must
        // still see sends recorded under a shorter interval after retention runs.
        await input.rateLimits.increment({ ownership: input.ownership, scope: "phone_purpose", scopeHash: cooldown, windowStart: input.now, windowSeconds: 1, expiresAt: new Date(input.now.getTime() + maximumPhoneCooldownSeconds * 1_000) }, input.tx);
        if (await input.rateLimits.countSince({ ownership: input.ownership, scope: "phone_purpose", scopeHash: cooldown, since: new Date(input.now.getTime() - input.policy.phoneMinIntervalSeconds * 1_000) }, input.tx) > 1) {
            throw new SmsKitError("RATE_LIMITED", "phone send interval is limited");
        }
    }
    if (await countTrailing(input.rateLimits, input.ownership, `hourly:${base}`, input.now, 60 * 60, input.tx) > input.policy.phoneHourlyLimit) {
        throw new SmsKitError("RATE_LIMITED", "phone hourly send limit is exceeded");
    }
    if (await countTrailing(input.rateLimits, input.ownership, `daily:${base}`, input.now, 24 * 60 * 60, input.tx) > input.policy.phoneDailyLimit) {
        throw new SmsKitError("RATE_LIMITED", "phone daily send limit is exceeded");
    }
}
