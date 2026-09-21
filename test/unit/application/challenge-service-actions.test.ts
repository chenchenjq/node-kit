import { describe, expect, it } from "vitest";

import { ChallengeService } from "../../../src/application/challenge-service.js";
import type { TenantId } from "../../../src/core/types.js";

const now = new Date("2026-09-21T00:00:00.000Z");
const tenantId = "tenant-auth" as TenantId;

function service(sent: unknown[], invalidations: unknown[] = []): ChallengeService {
  return new ChallengeService({
    store: {
      transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      policy: { get: async () => ({
        version: 1, otpLength: 6, otpTtlSeconds: 300, otpMaxAttempts: 5, proofTtlSeconds: 300,
        phoneMinIntervalSeconds: 0, phoneHourlyLimit: 5, phoneDailyLimit: 10,
        ipWindowSeconds: 3600, ipWindowLimit: 20, systemDailyBudget: null, circuitOpen: false,
      }) },
      rateLimits: { lock: async () => undefined, increment: async () => 1, countSince: async () => 1 },
      challenges: {
        getByIdempotency: async () => undefined,
        invalidateActiveForSubjectAction: async (input: unknown) => { invalidations.push(input); return 0; },
        create: async (input: any) => ({ ...input, attemptCount: 0, deliveryAcceptanceStatus: "pending" }),
        markDeliveryAcceptance: async (input: any) => ({ id: input.id, deliveryAcceptanceStatus: input.status }),
      },
    } as never,
    sendService: { sendOtpNow: async (input: unknown) => { sent.push(input); return { acceptanceStatus: "accepted" }; } } as never,
    phoneProtector: { protect: async () => ({ lookupHash: "phone-hash" }) } as never,
    hasher: { hash: async (value: string) => `hash:${value}`, verify: async () => false },
    clock: { now: () => new Date(now) },
    ids: { next: () => "challenge-1" },
    otpGenerator: { generate: () => "123456" },
  });
}

describe("ChallengeService native authentication actions", () => {
  it.each([
    ["login.authenticate", "auth.login_otp"],
    ["password.reset", "auth.password_reset"],
  ] as const)("maps %s to %s", async (action, templateKey) => {
    const sent: unknown[] = [];

    await service(sent).issue({
      tenantId, subjectId: "user-1", action, phone: "13800138000", idempotencyKey: `user-1:${action}`,
    });

    expect(sent).toEqual([expect.objectContaining({ templateKey, purpose: templateKey })]);
  });

  it("invalidates prior unused challenges for the same subject and action before issuing a replacement", async () => {
    const sent: unknown[] = [];
    const invalidations: unknown[] = [];
    const challengeService = service(sent, invalidations);

    await challengeService.issue({
      tenantId, subjectId: "user-1", action: "login.authenticate", phone: "13800138000", idempotencyKey: "login:1",
    });
    await challengeService.issue({
      tenantId, subjectId: "user-1", action: "login.authenticate", phone: "13800138000", idempotencyKey: "login:2",
    });

    expect(invalidations).toEqual([
      expect.objectContaining({ tenantId, subjectId: "user-1", action: "login.authenticate" }),
      expect.objectContaining({ tenantId, subjectId: "user-1", action: "login.authenticate" }),
    ]);
  });
});
