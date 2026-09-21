import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createBetterAuthTestHost, type BetterAuthTestHost } from "../../fixtures/better-auth-host.js";

describe("simulated authentication flows", () => {
  let host: BetterAuthTestHost;

  beforeAll(async () => {
    host = await createBetterAuthTestHost();
  }, 120_000);

  afterAll(async () => {
    await host.stop();
  });

  beforeEach(() => {
    host.clearProviderCalls();
  });

  it("sends a Better Auth login code only for an existing account", async () => {
    await host.requestLoginOtp("+8613800138000");
    await host.requestLoginOtp("+8613800138099");

    expect(host.fakeProvider.calls.send).toEqual([
      { templateKey: "auth.login_otp", purpose: "better-auth:login" },
    ]);
  });

  it("uses the password-reset template for an existing account without exposing unknown accounts", async () => {
    await host.requestPasswordResetOtp("+8613800138000");
    await host.requestPasswordResetOtp("+8613800138099");

    expect(host.fakeProvider.calls.send).toEqual([
      { templateKey: "auth.password_reset", purpose: "better-auth:passwordReset" },
    ]);
  });

  it("durably suppresses retries for one issuance but sends a later same-code issuance", async () => {
    const before = await host.authDeliveryCounts("better-auth:login");
    host.advanceTime(61_000);
    const firstIssuance = host.createOtpIssuance();

    await host.requestLoginOtp("+8613800138000", firstIssuance);
    host.advanceTime(61_000);
    await host.requestLoginOtp("+8613800138000", firstIssuance);
    const afterRetry = await host.authDeliveryCounts("better-auth:login");

    expect(host.fakeProvider.calls.send).toHaveLength(1);
    expect(afterRetry).toEqual({
      messages: before.messages + 1,
      attempts: before.attempts + 1,
      reservations: before.reservations + 1,
    });

    host.advanceTime(61_000);
    const laterIssuance = host.createOtpIssuance();
    await host.requestLoginOtp("+8613800138000", laterIssuance);
    const afterLaterIssuance = await host.authDeliveryCounts("better-auth:login");

    expect(host.fakeProvider.calls.send).toHaveLength(2);
    expect(afterLaterIssuance).toEqual({
      messages: before.messages + 2,
      attempts: before.attempts + 2,
      reservations: before.reservations + 2,
    });
    const stored = JSON.stringify(await host.storedAuthData());
    expect(stored).not.toContain("654321");
    expect(stored).not.toContain("+8613800138000");
    expect(stored).not.toContain(firstIssuance.id);
    expect(stored).not.toContain(laterIssuance.id);
  });

  it("requires a consumed proof in the password-change transaction", async () => {
    const proof = await host.issueAndVerifyPasswordChallenge();

    const first = await host.changePassword("user-1", proof, "pwd:42");
    const replay = await host.changePassword("user-1", proof, "pwd:42");
    const laterProof = await host.issueAndVerifyPasswordChallenge();
    const laterChange = await host.changePassword("user-1", laterProof, "pwd:43");
    const originalReplay = await host.changePassword("user-1", proof, "pwd:42");

    expect([first, replay, laterChange, originalReplay]).toEqual([2, 2, 3, 2]);
    expect(await host.passwordVersion("user-1")).toBe(3);
    await expect(host.changePassword("user-1", proof, "pwd:44")).rejects.toMatchObject({ code: "PROOF_INVALID" });
  });

  it("binds generic step-up verification to its user and action", async () => {
    const proof = await host.issueAndVerifyStepUpChallenge();

    await expect(host.consumeProof({ subjectId: "user-2", proof, action: "step.up", consumptionKey: "step-up:wrong-subject" })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    await expect(host.consumeProof({ subjectId: "user-1", proof, action: "password.change", consumptionKey: "step-up:wrong-action" })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    await expect(host.consumeProof({ subjectId: "user-1", proof, action: "step.up", consumptionKey: "step-up:42" })).resolves.toMatchObject({ consumed: true, replay: false });
  });
});
