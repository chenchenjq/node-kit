import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { phoneNumber } from "better-auth/plugins";

import { createBetterAuthPasswordResetPreRouteGuard, createBetterAuthSmsAdapter, type BetterAuthSmsAdapterOptions } from "../../src/better-auth/index.js";
import { SmsKitError } from "../../src/core/errors.js";
import type { TenantId } from "../../src/core/types.js";
import type { SmsTransaction } from "../../src/ports/store.js";
import { HmacHasher } from "../../src/security/hmac-hasher.js";

const tenant = "tenant-a" as TenantId;
const context = undefined;
const args = { phoneNumber: "+8613800138000", code: "123456" };

async function captureError(call: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
}

const policy = {
  version: 1,
  otpLength: 6,
  otpTtlSeconds: 300,
  otpMaxAttempts: 3,
  proofTtlSeconds: 300,
  phoneMinIntervalSeconds: 0,
  phoneHourlyLimit: 20,
  phoneDailyLimit: 50,
  ipWindowSeconds: 60,
  ipWindowLimit: 20,
  systemDailyBudget: null,
  circuitOpen: false,
};

class QueueScheduler {
  readonly tasks: Array<() => Promise<void>> = [];
  private rejection: Error | undefined;

  rejectNext(error: Error): void { this.rejection = error; }
  schedule(task: () => Promise<void>): void {
    if (this.rejection !== undefined) {
      const error = this.rejection;
      this.rejection = undefined;
      throw error;
    }
    this.tasks.push(task);
  }

  async drain(): Promise<void> { for (const task of this.tasks.splice(0)) await task(); }
}

function createOptions(existing = true, sleeperError?: Error, lookupError?: Error) {
  const callOrder: string[] = [];
  const issuanceRequests: Array<Record<string, unknown>> = [];
  const hashedInputs: string[] = [];
  const realHasher = new HmacHasher(Buffer.alloc(32, 17));
  let now = new Date("2026-09-13T00:00:00.000Z");
  let issuance = { id: "verification:issuance-1", expiresAt: new Date("2026-09-13T00:05:00.000Z") };
  const sendService = {
    calls: [] as Array<Record<string, unknown>>,
    async sendOtpNow(input: Record<string, unknown>) {
      this.calls.push(input);
      return {} as never;
    },
  };
  const scheduler = new QueueScheduler();
  const events: Array<Record<string, unknown>> = [];
  const delays: number[] = [];
  const options: BetterAuthSmsAdapterOptions = {
    sendService,
    isExistingPhone: async () => {
      callOrder.push("account-lookup");
      if (lookupError !== undefined) throw lookupError;
      return existing;
    },
    resolveTenant: async () => tenant,
    resolveTrustedIp: async () => "203.0.113.1",
    resolveOtpIssuance: async (input) => {
      issuanceRequests.push(input as unknown as Record<string, unknown>);
      return issuance;
    },
    scheduler,
    transaction: async <T>(work: (tx: SmsTransaction) => Promise<T>) => work({} as SmsTransaction),
    rateLimits: {
      lock: async ({ scopeHash }) => {
        if (scopeHash.startsWith("ip:")) callOrder.push("ip-limit");
        else if (scopeHash.startsWith("tenant:")) callOrder.push("tenant-limit");
        else callOrder.push("phone-limit");
      },
      increment: async () => 1,
      countSince: async () => 1,
    },
    policy: { get: async () => policy, update: async () => policy, holdBudget: async () => { throw new Error("not used"); }, releaseBudget: async () => false },
    hasher: { hash: async (value: string) => {
      hashedInputs.push(value);
      return realHasher.hash(value);
    } },
    clock: { now: () => new Date(now) },
    sleeper: { sleep: async (milliseconds) => {
      delays.push(milliseconds);
      if (sleeperError !== undefined) throw sleeperError;
    } },
    events: { emit: async (event) => { events.push(event as Record<string, unknown>); } },
  };
  return {
    options, sendService, scheduler, events, callOrder, delays, issuanceRequests, hashedInputs,
    setIssuance(value: { id: string; expiresAt: Date }): void { issuance = value; },
    setNow(value: Date): void { now = value; },
  };
}

describe("Better Auth SMS adapter", () => {
  it("maps login and password reset to distinct stable templates", async () => {
    const { options, sendService, scheduler } = createOptions();
    const adapter = createBetterAuthSmsAdapter(options);

    await adapter.sendOTP(args, context);
    await adapter.sendPasswordResetOTP?.({ ...args, code: "654321" }, context);
    await scheduler.drain();

    expect(sendService.calls.map((call) => call.templateKey)).toEqual(["auth.login_otp", "auth.password_reset"]);
  });

  it("does not send or reveal an unknown phone", async () => {
    const { options, sendService, scheduler, events } = createOptions(false);

    await expect(createBetterAuthSmsAdapter(options).sendOTP(args, context)).resolves.toBeUndefined();
    await scheduler.drain();

    expect(sendService.calls).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain(args.phoneNumber);
    expect(JSON.stringify(events)).not.toContain(args.code);
  });

  it("uses the same deterministic response envelope for known and unknown phones", async () => {
    const known = createOptions(true);
    const unknown = createOptions(false);

    await createBetterAuthSmsAdapter(known.options).sendOTP(args, context);
    await createBetterAuthSmsAdapter(unknown.options).sendOTP(args, context);

    expect(known.delays).toEqual([250]);
    expect(unknown.delays).toEqual([250]);
  });

  it("uses one issuance-scoped direct-send key across repeated callbacks and adapter instances", async () => {
    const { options, sendService, scheduler } = createOptions();

    await createBetterAuthSmsAdapter(options).sendOTP(args, context);
    await createBetterAuthSmsAdapter(options).sendOTP(args, context);
    await scheduler.drain();

    expect(sendService.calls).toHaveLength(2);
    expect(sendService.calls[0]?.idempotencyKey).toBe(sendService.calls[1]?.idempotencyKey);
    expect(JSON.stringify(sendService.calls.map((call) => call.idempotencyKey))).not.toContain(args.code);
  });

  it("uses a fresh key for a later issuance even when Better Auth repeats the same numeric code", async () => {
    const harness = createOptions();
    const adapter = createBetterAuthSmsAdapter(harness.options);

    await adapter.sendOTP(args, context);
    harness.setIssuance({ id: "verification:issuance-2", expiresAt: new Date("2026-09-13T00:05:00.000Z") });
    await adapter.sendOTP(args, context);
    await harness.scheduler.drain();

    expect(harness.sendService.calls).toHaveLength(2);
    expect(harness.sendService.calls[0]?.idempotencyKey).not.toBe(harness.sendService.calls[1]?.idempotencyKey);
    expect(JSON.stringify(harness.hashedInputs)).not.toContain(args.code);
  });

  it("resolves the exact trusted issuance without passing OTP digits", async () => {
    const harness = createOptions();

    await createBetterAuthSmsAdapter(harness.options).sendOTP(args, context);

    expect(harness.issuanceRequests).toEqual([{ tenantId: tenant, phone: "+8613800138000", purpose: "login", context }]);
    expect(JSON.stringify(harness.issuanceRequests)).not.toContain(args.code);
  });

  it("maps expired issuance correlation to the safe response envelope", async () => {
    const harness = createOptions();
    const secretIssuance = "verification:secret-expired-issuance";
    harness.setIssuance({ id: secretIssuance, expiresAt: new Date("2026-09-13T00:00:00.000Z") });

    const error = await captureError(() => createBetterAuthSmsAdapter(harness.options).sendOTP(args, context));

    expect(error).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(JSON.stringify(error)).not.toContain(secretIssuance);
    expect(JSON.stringify(error)).not.toContain(args.code);
    expect(harness.scheduler.tasks).toHaveLength(0);
  });

  it("rechecks issuance expiry before a delayed background send", async () => {
    const harness = createOptions();

    await createBetterAuthSmsAdapter(harness.options).sendOTP(args, context);
    harness.setNow(new Date("2026-09-13T00:05:00.000Z"));
    await harness.scheduler.drain();

    expect(harness.sendService.calls).toHaveLength(0);
    expect(harness.events).toContainEqual(expect.objectContaining({ code: "STORAGE_FAILURE" }));
    expect(JSON.stringify(harness.events)).not.toContain(args.code);
  });

  it("fails closed when the background clock is invalid", async () => {
    const harness = createOptions();

    await createBetterAuthSmsAdapter(harness.options).sendOTP(args, context);
    harness.setNow(new Date(Number.NaN));
    await harness.scheduler.drain();

    expect(harness.sendService.calls).toHaveLength(0);
    expect(harness.events).toContainEqual(expect.objectContaining({ code: "STORAGE_FAILURE" }));
    expect(JSON.stringify(harness.events)).not.toContain(args.code);
  });

  it("rejects safely when issuance expires while deriving its idempotency key", async () => {
    const harness = createOptions();
    const expiresAt = new Date("2026-09-13T00:05:00.000Z");
    const underlyingHasher = harness.options.hasher;
    harness.setIssuance({ id: "verification:expires-during-hash", expiresAt });
    const options = {
      ...harness.options,
      hasher: {
        async hash(value: string): Promise<string> {
          const result = await underlyingHasher.hash(value);
          if (value.includes("better-auth:issuance-idempotency:v2")) harness.setNow(expiresAt);
          return result;
        },
      },
    };

    const error = await captureError(() => createBetterAuthSmsAdapter(options).sendOTP(args, context));

    expect(error).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(JSON.stringify(error)).not.toContain("expires-during-hash");
    expect(JSON.stringify(error)).not.toContain(args.code);
    expect(harness.scheduler.tasks).toHaveLength(0);
  });

  it("applies phone, IP and tenant limits before the tenant-scoped account lookup", async () => {
    const { options, callOrder } = createOptions();
    await createBetterAuthSmsAdapter(options).sendOTP(args, context);

    expect(callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup"]);
  });

  it("converts a scheduler rejection to a safe storage error and observes background failures", async () => {
    const { options, scheduler, events } = createOptions();
    const adapter = createBetterAuthSmsAdapter(options);
    scheduler.rejectNext(new Error("scheduler unavailable"));

    await expect(adapter.sendOTP(args, context)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });

    options.sendService.sendOtpNow = async () => { throw new Error("background send failed"); };
    await adapter.sendOTP({ ...args, code: "654321" }, context);
    await scheduler.drain();

    expect(events.at(-1)).toMatchObject({ code: "STORAGE_FAILURE" });
    expect(JSON.stringify(events)).not.toContain(args.phoneNumber);
    expect(JSON.stringify(events)).not.toContain(args.code);
  });

  it("normalizes host failures into a fresh safe error after the same envelope", async () => {
    const secret = "+8613800138000/tenant-a";
    const hostError = new SmsKitError("CONFIG_INVALID", secret, false, { phoneNumber: [secret] }, secret);
    const known = createOptions(true, undefined, hostError);
    const unknown = createOptions(false, undefined, hostError);

    const knownError = await captureError(() => createBetterAuthSmsAdapter(known.options).sendOTP(args, context));
    const unknownError = await captureError(() => createBetterAuthSmsAdapter(unknown.options).sendOTP(args, context));

    expect(knownError).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(unknownError).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(knownError).not.toBe(hostError);
    expect(unknownError).not.toBe(hostError);
    expect(JSON.stringify(knownError)).not.toContain(secret);
    expect(JSON.stringify(unknownError)).not.toContain(secret);
    expect(known.delays).toEqual([250]);
    expect(unknown.delays).toEqual([250]);
  });

  it("normalizes sleeper failure identically after known and unknown branches", async () => {
    const known = createOptions(true, new Error("known sleeper failure"));
    const unknown = createOptions(false, new Error("unknown sleeper failure"));

    const knownError = await captureError(() => createBetterAuthSmsAdapter(known.options).sendOTP(args, context));
    const unknownError = await captureError(() => createBetterAuthSmsAdapter(unknown.options).sendOTP(args, context));

    expect(knownError).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(unknownError).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(JSON.stringify(knownError)).not.toContain("known sleeper failure");
    expect(JSON.stringify(unknownError)).not.toContain("unknown sleeper failure");
  });

  it("envelopes the actual reset route when its unknown branch skips the Better Auth callback", async () => {
    const known = createOptions(true);
    const unknown = createOptions(false);
    const knownGuard = createBetterAuthPasswordResetPreRouteGuard(known.options);
    const unknownGuard = createBetterAuthPasswordResetPreRouteGuard(unknown.options);
    let knownCallbackCalls = 0;
    let unknownCallbackCalls = 0;

    // This fixture models Better Auth 1.7.4's reset route: it looks up first and only invokes
    // sendPasswordResetOTP for a user it found, while returning { status: true } for both.
    const resetRoute = async (exists: boolean, callback: () => Promise<void>) => {
      if (exists) await callback();
      return { status: true };
    };

    await knownGuard.run({ phoneNumber: args.phoneNumber, context, next: () => resetRoute(true, async () => { knownCallbackCalls += 1; }) });
    await unknownGuard.run({ phoneNumber: args.phoneNumber, context, next: () => resetRoute(false, async () => { unknownCallbackCalls += 1; }) });

    expect(knownCallbackCalls).toBe(1);
    expect(unknownCallbackCalls).toBe(0);
    expect(known.delays).toEqual([250]);
    expect(unknown.delays).toEqual([250]);
    expect(known.callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup"]);
    expect(unknown.callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup"]);
  });

  it("reuses the guarded reset preflight when Better Auth reaches the existing-account callback", async () => {
    const harness = createOptions(true);
    const callbacks = createBetterAuthSmsAdapter(harness.options);
    const guard = createBetterAuthPasswordResetPreRouteGuard(harness.options);

    await guard.run({
      phoneNumber: args.phoneNumber,
      context,
      next: async () => {
        await callbacks.sendPasswordResetOTP?.(args, context);
        return { status: true };
      },
    });
    await harness.scheduler.drain();

    expect(harness.callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup"]);
    expect(harness.sendService.calls).toHaveLength(1);
  });

  it("uses one advancing-clock response envelope when the real reset callback runs", async () => {
    const harness = createOptions(true);
    let current = new Date("2026-09-13T00:00:00.000Z").getTime();
    const delays: number[] = [];
    const options: BetterAuthSmsAdapterOptions = {
      ...harness.options,
      clock: { now: () => new Date(current) },
      sleeper: { sleep: async (milliseconds) => { delays.push(milliseconds); current += milliseconds; } },
    };
    const callbacks = createBetterAuthSmsAdapter(options);
    const guard = createBetterAuthPasswordResetPreRouteGuard(options);

    await guard.run({
      phoneNumber: args.phoneNumber,
      context,
      next: async () => {
        await callbacks.sendPasswordResetOTP?.(args, context);
        return { status: true };
      },
    });

    expect(delays).toEqual([250]);
    expect(current).toBe(new Date("2026-09-13T00:00:00.250Z").getTime());
    expect(harness.callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup"]);
  });

  it("surfaces a scheduler failure swallowed by Better Auth's real reset route", async () => {
    const harness = createOptions(true);
    harness.scheduler.rejectNext(new Error("scheduler unavailable"));
    const callbacks = createBetterAuthSmsAdapter(harness.options);
    const auth = betterAuth({
      secret: "better-auth-test-secret-that-is-long-enough",
      baseURL: "http://localhost:3000",
      emailAndPassword: { enabled: true },
      rateLimit: { enabled: false },
      logger: { disabled: true },
      plugins: [phoneNumber({ ...callbacks, allowedAttempts: 3 })],
    });
    const created = await auth.api.signUpEmail({ body: { email: "sms@example.test", password: "test-password", name: "SMS User" } });
    await ((await auth.$context).adapter as any).update({
      model: "user",
      update: { phoneNumber: args.phoneNumber, phoneNumberVerified: true },
      where: [{ field: "id", value: created.user.id }],
    });
    const guard = createBetterAuthPasswordResetPreRouteGuard(harness.options);

    await expect(guard.run({
      phoneNumber: args.phoneNumber,
      context,
      next: () => auth.api.requestPasswordResetPhoneNumber({ body: { phoneNumber: args.phoneNumber } }),
    })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
    expect(harness.callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup"]);
  });

  it("maps initial clock acquisition failures for callbacks and guards", async () => {
    const harness = createOptions(true);
    const options: BetterAuthSmsAdapterOptions = {
      ...harness.options,
      clock: { now: () => { throw new Error("clock secret"); } },
    };
    const callbacks = createBetterAuthSmsAdapter(options);
    const guard = createBetterAuthPasswordResetPreRouteGuard(options);

    const callbackError = await captureError(() => callbacks.sendOTP(args, context));
    const guardError = await captureError(() => guard.run({ phoneNumber: args.phoneNumber, context, next: async () => ({ status: true }) }));

    expect(callbackError).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(guardError).toMatchObject({ code: "STORAGE_FAILURE", message: "SMS delivery is temporarily unavailable" });
    expect(JSON.stringify(callbackError)).not.toContain("clock secret");
    expect(JSON.stringify(guardError)).not.toContain("clock secret");
  });
});
