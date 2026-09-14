import { describe, expect, it } from "vitest";

import { createBetterAuthSmsAdapter, type BetterAuthSmsAdapterOptions } from "../../src/better-auth/index.js";
import type { TenantId } from "../../src/core/types.js";
import type { SmsTransaction } from "../../src/ports/store.js";

const tenant = "tenant-a" as TenantId;
const context = undefined;
const args = { phoneNumber: "+8613800138000", code: "123456" };

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

function createOptions(existing = true) {
  const callOrder: string[] = [];
  const sendService = {
    calls: [] as Array<Record<string, unknown>>,
    async sendOtpNow(input: Record<string, unknown>) {
      if (!this.calls.some((call) => call.idempotencyKey === input.idempotencyKey)) this.calls.push(input);
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
      return existing;
    },
    resolveTenant: async () => tenant,
    resolveTrustedIp: async () => "203.0.113.1",
    scheduler,
    transaction: async <T>(work: (tx: SmsTransaction) => Promise<T>) => work({} as SmsTransaction),
    rateLimits: {
      lock: async ({ scopeHash }) => {
        if (scopeHash.includes("phone")) callOrder.push("phone-limit");
        else if (scopeHash.includes("ip")) callOrder.push("ip-limit");
        else callOrder.push("tenant-limit");
      },
      increment: async () => 1,
      countSince: async () => 1,
    },
    policy: { get: async () => policy, update: async () => policy, holdBudget: async () => { throw new Error("not used"); }, releaseBudget: async () => false },
    hasher: { hash: async (value: string) => value.replace(/[^a-z]/g, "") },
    clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
    sleeper: { sleep: async (milliseconds) => { delays.push(milliseconds); } },
    events: { emit: async (event) => { events.push(event as Record<string, unknown>); } },
  };
  return { options, sendService, scheduler, events, callOrder, delays };
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

  it("uses one direct-send idempotency key for a repeated Better Auth callback", async () => {
    const { options, sendService, scheduler } = createOptions();
    const adapter = createBetterAuthSmsAdapter(options);

    await adapter.sendOTP(args, context);
    await adapter.sendOTP(args, context);
    await scheduler.drain();

    expect(sendService.calls).toHaveLength(1);
    expect(JSON.stringify(sendService.calls.map((call) => call.idempotencyKey))).not.toContain(args.code);
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
});
