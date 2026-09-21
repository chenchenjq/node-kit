import type { phoneNumber } from "better-auth/plugins";

import type { SendService } from "../application/send-service.js";
import type { TenantId } from "../core/types.js";
import type { PolicyStore } from "../ports/policy.js";
import type { BackgroundTaskScheduler, Clock, EventSink, Sleeper } from "../ports/runtime.js";
import type { OtpHasher } from "../ports/security.js";
import type { RateLimitRepository, SmsTransaction } from "../ports/store.js";

type PhoneNumberOptions = NonNullable<Parameters<typeof phoneNumber>[0]>;

/** Callback types are derived from the installed Better Auth plugin, never copied. */
export type BetterAuthSendOtp = NonNullable<PhoneNumberOptions["sendOTP"]>;
export type BetterAuthSendPasswordResetOtp = NonNullable<PhoneNumberOptions["sendPasswordResetOTP"]>;
export type BetterAuthOtpInput = Parameters<BetterAuthSendOtp>[0];
export type BetterAuthCallbackContext = Parameters<BetterAuthSendOtp>[1];
export type BetterAuthSmsCallbacks = Pick<PhoneNumberOptions, "sendOTP" | "sendPasswordResetOTP">;
export type BetterAuthOtpPurpose = "login" | "passwordReset";
export type BetterAuthOtpIssuance = Readonly<{ id: string; expiresAt: Date }>;
export type BetterAuthOtpIssuanceInput = Readonly<{
  tenantId: TenantId;
  phone: string;
  purpose: BetterAuthOtpPurpose;
  context: BetterAuthCallbackContext;
}>;

/** Wrap the complete Better Auth password-reset route, not only its callback. */
export type BetterAuthPasswordResetPreRouteGuardInput<T> = Readonly<{
  phoneNumber: string;
  context: BetterAuthCallbackContext;
  next: () => Promise<T>;
}>;

export type BetterAuthPasswordResetPreRouteGuard = Readonly<{
  run<T>(input: BetterAuthPasswordResetPreRouteGuardInput<T>): Promise<T>;
}>;

export type BetterAuthSmsAdapterOptions = Readonly<{
  sendService: Pick<SendService, "sendOtpNow">;
  /** This host-owned lookup must predicate every query by the trusted tenant. */
  isExistingPhone(tenantId: TenantId, phone: string): Promise<boolean>;
  resolveTenant(context: BetterAuthCallbackContext): Promise<TenantId>;
  resolveTrustedIp(context: BetterAuthCallbackContext): Promise<string | undefined>;
  /**
   * Resolves the exact host-owned Better Auth verification issuance. Its opaque
   * ID must remain stable for retries and differ for every newly issued OTP.
   */
  resolveOtpIssuance(input: BetterAuthOtpIssuanceInput): Promise<BetterAuthOtpIssuance>;
  scheduler: BackgroundTaskScheduler<BetterAuthCallbackContext>;
  /** Runs rate enforcement and the account lookup under one host transaction. */
  transaction<T>(work: (tx: SmsTransaction) => Promise<T>): Promise<T>;
  rateLimits: RateLimitRepository;
  policy: PolicyStore;
  /** A host-provisioned keyed HMAC implementation; values passed to it are never persisted or emitted. */
  hasher: Pick<OtpHasher, "hash">;
  clock: Clock;
  sleeper: Sleeper;
  events: EventSink;
  templates?: Readonly<{ login?: string; passwordReset?: string }>;
  minimumResponseMs?: number;
}>;
