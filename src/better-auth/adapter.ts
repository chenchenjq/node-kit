import { SmsKitError } from "../core/errors.js";
import { normalizeMainlandPhone } from "../core/phone.js";
import type { TenantId } from "../core/types.js";
import { enforcePhoneSendPolicy } from "../application/send-policy.js";
import type { VerificationPolicy } from "../ports/policy.js";
import type { SmsTransaction } from "../ports/store.js";
import type {
  BetterAuthCallbackContext,
  BetterAuthOtpInput,
  BetterAuthPasswordResetPreRouteGuard,
  BetterAuthPasswordResetPreRouteGuardInput,
  BetterAuthSendOtp,
  BetterAuthSendPasswordResetOtp,
  BetterAuthSmsAdapterOptions,
  BetterAuthSmsCallbacks,
} from "./types.js";

type Purpose = "login" | "passwordReset";
type Preflight = Readonly<{ owner: BetterAuthSmsAdapterOptions; tenantId: TenantId; phone: string; exists: boolean }>;

const DEFAULT_TEMPLATES = Object.freeze({ login: "auth.login_otp", passwordReset: "auth.password_reset" });
const DEFAULT_MINIMUM_RESPONSE_MS = 250;

function requireTrustedTenant(tenantId: TenantId): void {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new SmsKitError("PERMISSION_DENIED", "trusted tenant is required");
  }
}

function storageFailure(): SmsKitError {
  return new SmsKitError("STORAGE_FAILURE", "SMS delivery is temporarily unavailable", true);
}

function windowStart(now: Date, seconds: number): Date {
  return new Date(Math.floor(now.getTime() / (seconds * 1_000)) * seconds * 1_000);
}

async function emitFailure(options: BetterAuthSmsAdapterOptions): Promise<void> {
  try {
    await options.events.emit({
      name: "sms.better-auth.dispatch.failed",
      level: "error",
      code: "STORAGE_FAILURE",
      metadata: { redactedFields: ["phone", "otp"] },
    });
  } catch {
    // Diagnostics cannot make a background task reject after its failure was observed.
  }
}

async function applyIpAndTenantLimits(input: Readonly<{
  options: BetterAuthSmsAdapterOptions;
  policy: VerificationPolicy;
  tenantId: TenantId;
  purpose: Purpose;
  trustedIp: string | undefined;
  now: Date;
  tx: SmsTransaction;
}>): Promise<void> {
  const { options, policy, tenantId, purpose, trustedIp, now, tx } = input;
  const start = windowStart(now, policy.ipWindowSeconds);
  const expiresAt = new Date(start.getTime() + policy.ipWindowSeconds * 1_000);

  if (trustedIp !== undefined) {
    const ipScope = await options.hasher.hash(`better-auth:ip:${purpose}:${trustedIp}`);
    await options.rateLimits.lock({ tenantId, scopeHash: `ip:${ipScope}` }, tx);
    if (await options.rateLimits.increment({ tenantId, scope: "ip_purpose", scopeHash: ipScope, windowStart: start, windowSeconds: policy.ipWindowSeconds, expiresAt }, tx) > policy.ipWindowLimit) {
      throw new SmsKitError("RATE_LIMITED", "SMS request is temporarily limited");
    }
  }

  const tenantScope = await options.hasher.hash(`better-auth:tenant:${purpose}`);
  await options.rateLimits.lock({ tenantId, scopeHash: `tenant:${tenantScope}` }, tx);
  if (await options.rateLimits.increment({ tenantId, scope: "global", scopeHash: tenantScope, windowStart: start, windowSeconds: policy.ipWindowSeconds, expiresAt }, tx) > policy.ipWindowLimit) {
    throw new SmsKitError("RATE_LIMITED", "SMS request is temporarily limited");
  }
}

async function waitForEnvelope(options: BetterAuthSmsAdapterOptions, startedAt: Date): Promise<void> {
  const minimum = options.minimumResponseMs ?? DEFAULT_MINIMUM_RESPONSE_MS;
  const elapsed = options.clock.now().getTime() - startedAt.getTime();
  await options.sleeper.sleep(Math.max(0, minimum - elapsed));
}

const resetPreflight = new AsyncLocalStorage<Preflight>();

/** Every host failure becomes a fresh value with no host-controlled fields, causes, or message. */
async function withinResponseEnvelope<T>(options: BetterAuthSmsAdapterOptions, work: () => Promise<T>): Promise<T> {
  const startedAt = options.clock.now();
  let result: T | undefined;
  let failed = false;
  try {
    result = await work();
  } catch {
    failed = true;
  }
  try {
    await waitForEnvelope(options, startedAt);
  } catch {
    failed = true;
  }
  if (failed) throw storageFailure();
  return result as T;
}

async function preflightKnownPhone(
  options: BetterAuthSmsAdapterOptions,
  purpose: Purpose,
  inputPhone: string,
  context: BetterAuthCallbackContext,
): Promise<Preflight> {
  const [tenantId, trustedIp] = await Promise.all([options.resolveTenant(context), options.resolveTrustedIp(context)]);
  requireTrustedTenant(tenantId);
  const phone = normalizeMainlandPhone(inputPhone);
  const phoneHash = await options.hasher.hash(`better-auth:phone:${purpose}:${phone}`);
  const exists = await options.transaction(async (tx) => {
    const policy = await options.policy.get(tx);
    await enforcePhoneSendPolicy({
      policy,
      rateLimits: options.rateLimits,
      tenantId,
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

/**
 * Bridges Better Auth's callbacks to SMS Kit without allowing account existence,
 * tenant identity, phones, or OTPs to leave this trusted server boundary.
 */
export function createBetterAuthSmsAdapter(options: BetterAuthSmsAdapterOptions): BetterAuthSmsCallbacks {
  const dispatchKnownPhone = async (purpose: Purpose, input: BetterAuthOtpInput, context: BetterAuthCallbackContext): Promise<void> => {
    await withinResponseEnvelope(options, async () => {
      const guarded = purpose === "passwordReset" ? resetPreflight.getStore() : undefined;
      const normalizedInput = normalizeMainlandPhone(input.phoneNumber);
      const preflight = guarded !== undefined && guarded.owner === options && guarded.phone === normalizedInput
        ? guarded
        : await preflightKnownPhone(options, purpose, input.phoneNumber, context);
      if (!preflight.exists) return;

      const idempotencyHash = await options.hasher.hash(`better-auth:send:${preflight.tenantId}\u0000${preflight.phone}\u0000${input.code}`);
      const templateKey = purpose === "login" ? (options.templates?.login ?? DEFAULT_TEMPLATES.login) : (options.templates?.passwordReset ?? DEFAULT_TEMPLATES.passwordReset);
      const task = async (): Promise<void> => {
        try {
          await options.sendService.sendOtpNow({
            tenantId: preflight.tenantId,
            templateKey,
            phone: preflight.phone,
            variables: { code: input.code },
            purpose: `better-auth:${purpose}`,
            idempotencyKey: `better-auth:${purpose}:${idempotencyHash}`,
          });
        } catch {
          await emitFailure(options);
        }
      };

      try {
        await options.scheduler.schedule(task, context);
      } catch {
        await emitFailure(options);
        throw storageFailure();
      }
    });
  };

  return {
    sendOTP: ((input, context) => dispatchKnownPhone("login", input, context)) satisfies BetterAuthSendOtp,
    sendPasswordResetOTP: ((input, context) => dispatchKnownPhone("passwordReset", input, context)) satisfies BetterAuthSendPasswordResetOtp,
  } satisfies BetterAuthSmsCallbacks;
}

/**
 * Applies the trusted reset-request preflight around the complete Better Auth
 * route. Better Auth 1.7.4 skips `sendPasswordResetOTP` for unknown users, so
 * wrapping only that callback cannot provide a constant response envelope.
 */
export function createBetterAuthPasswordResetPreRouteGuard(options: BetterAuthSmsAdapterOptions): BetterAuthPasswordResetPreRouteGuard {
  return {
    async run<T>(input: BetterAuthPasswordResetPreRouteGuardInput<T>): Promise<T> {
      return withinResponseEnvelope(options, async () => {
        const preflight = await preflightKnownPhone(options, "passwordReset", input.phoneNumber, input.context);
        return resetPreflight.run(preflight, input.next);
      });
    },
  };
}
import { AsyncLocalStorage } from "node:async_hooks";
