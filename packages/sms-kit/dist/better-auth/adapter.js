import { AsyncLocalStorage } from "node:async_hooks";
import { SmsKitError } from "../core/errors.js";
import { normalizeMainlandPhone } from "../core/phone.js";
import { tenantScope } from "../core/types.js";
import { enforcePhoneSendPolicy } from "../application/send-policy.js";
const DEFAULT_TEMPLATES = Object.freeze({ login: "auth.login_otp", passwordReset: "auth.password_reset" });
const DEFAULT_MINIMUM_RESPONSE_MS = 250;
function requireTrustedTenant(tenantId) {
    if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
        throw new SmsKitError("PERMISSION_DENIED", "trusted tenant is required");
    }
}
function storageFailure() {
    return new SmsKitError("STORAGE_FAILURE", "SMS delivery is temporarily unavailable", true);
}
function activeIssuance(value, now) {
    const valid = typeof value === "object"
        && value !== null
        && typeof value.id === "string"
        && value.id.length > 0
        && value.id.length <= 512
        && value.id === value.id.trim()
        && value.expiresAt instanceof Date
        && Number.isFinite(value.expiresAt.getTime())
        && value.expiresAt.getTime() > now.getTime();
    return valid ? { id: value.id, expiresAtMs: value.expiresAt.getTime() } : undefined;
}
function windowStart(now, seconds) {
    return new Date(Math.floor(now.getTime() / (seconds * 1_000)) * seconds * 1_000);
}
async function emitFailure(options) {
    try {
        await options.events.emit({
            name: "sms.better-auth.dispatch.failed",
            level: "error",
            code: "STORAGE_FAILURE",
            metadata: { redactedFields: ["phone", "otp"] },
        });
    }
    catch {
        // Diagnostics cannot make a background task reject after its failure was observed.
    }
}
async function applyIpAndTenantLimits(input) {
    const { options, policy, tenantId, purpose, trustedIp, now, tx } = input;
    const start = windowStart(now, policy.ipWindowSeconds);
    const expiresAt = new Date(start.getTime() + policy.ipWindowSeconds * 1_000);
    if (trustedIp !== undefined) {
        const ipScope = await options.hasher.hash(`better-auth:ip:${purpose}:${trustedIp}`);
        await options.rateLimits.lock({ ownership: tenantScope(tenantId), scopeHash: `ip:${ipScope}` }, tx);
        if (await options.rateLimits.increment({ ownership: tenantScope(tenantId), scope: "ip_purpose", scopeHash: ipScope, windowStart: start, windowSeconds: policy.ipWindowSeconds, expiresAt }, tx) > policy.ipWindowLimit) {
            throw new SmsKitError("RATE_LIMITED", "SMS request is temporarily limited");
        }
    }
    const tenantLimitScope = await options.hasher.hash(`better-auth:tenant:${purpose}`);
    await options.rateLimits.lock({ ownership: tenantScope(tenantId), scopeHash: `tenant:${tenantLimitScope}` }, tx);
    if (await options.rateLimits.increment({ ownership: tenantScope(tenantId), scope: "global", scopeHash: tenantLimitScope, windowStart: start, windowSeconds: policy.ipWindowSeconds, expiresAt }, tx) > policy.ipWindowLimit) {
        throw new SmsKitError("RATE_LIMITED", "SMS request is temporarily limited");
    }
}
async function waitForEnvelope(options, startedAt) {
    const minimum = options.minimumResponseMs ?? DEFAULT_MINIMUM_RESPONSE_MS;
    const elapsed = options.clock.now().getTime() - startedAt.getTime();
    await options.sleeper.sleep(Math.max(0, minimum - elapsed));
}
const resetPreflight = new AsyncLocalStorage();
/** Every host failure becomes a fresh value with no host-controlled fields, causes, or message. */
async function withinResponseEnvelope(options, work) {
    let envelope;
    try {
        envelope = { startedAt: options.clock.now(), callbackFailed: false };
    }
    catch {
        throw storageFailure();
    }
    let result;
    let failed = false;
    try {
        result = await work(envelope);
    }
    catch {
        failed = true;
    }
    if (envelope.callbackFailed)
        failed = true;
    try {
        await waitForEnvelope(options, envelope.startedAt);
    }
    catch {
        failed = true;
    }
    if (failed)
        throw storageFailure();
    return result;
}
async function preflightKnownPhone(options, purpose, inputPhone, context) {
    const [tenantId, trustedIp] = await Promise.all([options.resolveTenant(context), options.resolveTrustedIp(context)]);
    requireTrustedTenant(tenantId);
    const phone = normalizeMainlandPhone(inputPhone);
    const phoneHash = await options.hasher.hash(`better-auth:phone:${purpose}:${phone}`);
    const exists = await options.transaction(async (tx) => {
        const policy = await options.policy.get(tx);
        await enforcePhoneSendPolicy({
            policy,
            rateLimits: options.rateLimits,
            ownership: tenantScope(tenantId),
            phoneHash,
            purpose: `better-auth:${purpose}`,
            now: options.clock.now(),
            tx,
        });
        await applyIpAndTenantLimits({ options, policy, tenantId, purpose, trustedIp, now: options.clock.now(), tx });
        return options.isExistingPhone(tenantId, phone);
    });
    return { owner: options, tenantId, phone, exists };
}
async function scheduleKnownPhone(options, purpose, input, context, preflight) {
    if (!preflight.exists)
        return;
    const resolvedIssuance = await options.resolveOtpIssuance({
        tenantId: preflight.tenantId,
        phone: preflight.phone,
        purpose,
        context,
    });
    const issuance = activeIssuance(resolvedIssuance, options.clock.now());
    if (issuance === undefined)
        throw storageFailure();
    const idempotencyHash = await options.hasher.hash(JSON.stringify([
        "better-auth:issuance-idempotency:v2",
        preflight.tenantId,
        purpose,
        preflight.phone,
        issuance.id,
    ]));
    const templateKey = purpose === "login" ? (options.templates?.login ?? DEFAULT_TEMPLATES.login) : (options.templates?.passwordReset ?? DEFAULT_TEMPLATES.passwordReset);
    const task = async () => {
        try {
            const executedAtMs = options.clock.now().getTime();
            if (!Number.isFinite(executedAtMs) || issuance.expiresAtMs <= executedAtMs)
                throw storageFailure();
            await options.sendService.sendOtpNow({
                tenantId: preflight.tenantId,
                templateKey,
                phone: preflight.phone,
                variables: { code: input.code },
                purpose: `better-auth:${purpose}`,
                idempotencyKey: `better-auth:v2:${purpose}:${idempotencyHash}`,
            });
        }
        catch {
            await emitFailure(options);
        }
    };
    try {
        const scheduledAtMs = options.clock.now().getTime();
        if (!Number.isFinite(scheduledAtMs) || issuance.expiresAtMs <= scheduledAtMs)
            throw storageFailure();
        await options.scheduler.schedule(task, context);
    }
    catch {
        if (preflight.envelope !== undefined)
            preflight.envelope.callbackFailed = true;
        await emitFailure(options);
        throw storageFailure();
    }
}
/**
 * Bridges Better Auth's callbacks to SMS Kit without allowing account existence,
 * tenant identity, phones, or OTPs to leave this trusted server boundary.
 */
export function createBetterAuthSmsAdapter(options) {
    const dispatchKnownPhone = async (purpose, input, context) => {
        const guarded = purpose === "passwordReset" ? resetPreflight.getStore() : undefined;
        if (guarded !== undefined) {
            let normalizedInput;
            try {
                normalizedInput = normalizeMainlandPhone(input.phoneNumber);
            }
            catch {
                if (guarded.envelope !== undefined)
                    guarded.envelope.callbackFailed = true;
                throw storageFailure();
            }
            if (guarded.owner === options && guarded.phone === normalizedInput) {
                try {
                    await scheduleKnownPhone(options, purpose, input, context, guarded);
                }
                catch {
                    if (guarded.envelope !== undefined)
                        guarded.envelope.callbackFailed = true;
                    throw storageFailure();
                }
                return;
            }
        }
        await withinResponseEnvelope(options, async () => {
            const preflight = await preflightKnownPhone(options, purpose, input.phoneNumber, context);
            await scheduleKnownPhone(options, purpose, input, context, preflight);
        });
    };
    return {
        sendOTP: ((input, context) => dispatchKnownPhone("login", input, context)),
        sendPasswordResetOTP: ((input, context) => dispatchKnownPhone("passwordReset", input, context)),
    };
}
/**
 * Applies the trusted reset-request preflight around the complete Better Auth
 * route. Better Auth 1.7.4 skips `sendPasswordResetOTP` for unknown users, so
 * wrapping only that callback cannot provide a constant response envelope.
 */
export function createBetterAuthPasswordResetPreRouteGuard(options) {
    return {
        async run(input) {
            return withinResponseEnvelope(options, async (envelope) => {
                const preflight = await preflightKnownPhone(options, "passwordReset", input.phoneNumber, input.context);
                return resetPreflight.run({ ...preflight, envelope }, input.next);
            });
        },
    };
}
