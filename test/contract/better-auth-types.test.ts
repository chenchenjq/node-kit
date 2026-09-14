import { expect, it } from "vitest";
import { phoneNumber } from "better-auth/plugins";

import { createBetterAuthSmsAdapter, type BetterAuthSmsAdapterOptions } from "../../src/better-auth/index.js";
import type { TenantId } from "../../src/core/types.js";
import type { SmsTransaction } from "../../src/ports/store.js";

it("is accepted by the installed Better Auth phone plugin", () => {
  const options: BetterAuthSmsAdapterOptions = {
    sendService: { sendOtpNow: async () => ({}) as never },
    isExistingPhone: async () => true,
    resolveTenant: async () => "tenant-a" as TenantId,
    resolveTrustedIp: async () => undefined,
    resolveOtpIssuance: async () => ({ id: "verification:issuance-1", expiresAt: new Date(Date.now() + 300_000) }),
    scheduler: { schedule: () => undefined },
    transaction: async <T>(work: (tx: SmsTransaction) => Promise<T>) => work({} as SmsTransaction),
    rateLimits: { lock: async () => undefined, increment: async () => 1, countSince: async () => 1 },
    policy: {
      get: async () => ({ version: 1, otpLength: 6, otpTtlSeconds: 300, otpMaxAttempts: 3, proofTtlSeconds: 300, phoneMinIntervalSeconds: 0, phoneHourlyLimit: 1, phoneDailyLimit: 1, ipWindowSeconds: 60, ipWindowLimit: 1, systemDailyBudget: null, circuitOpen: false }),
      update: async () => { throw new Error("not used"); }, holdBudget: async () => { throw new Error("not used"); }, releaseBudget: async () => false,
    },
    hasher: { hash: async () => "safe-keyed-hash" },
    clock: { now: () => new Date() },
    sleeper: { sleep: async () => undefined },
    events: { emit: async () => undefined },
  };

  const callbacks = createBetterAuthSmsAdapter(options);
  const plugin = phoneNumber({ ...callbacks, allowedAttempts: 3 });
  expect(plugin).toBeDefined();
});
