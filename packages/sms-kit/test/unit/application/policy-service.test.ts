import { describe, expect, it } from "vitest";

import { ConfigService } from "../../../src/application/config-service.js";
import { PolicyService } from "../../../src/application/policy-service.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import type { VerificationPolicy } from "../../../src/ports/policy.js";

const actor = { id: "operator", tenantId: "system" } as AuthorizationActor;
const defaultPolicy: VerificationPolicy = {
  version: 1, otpLength: 6, otpTtlSeconds: 300, otpMaxAttempts: 3, proofTtlSeconds: 300,
  phoneMinIntervalSeconds: 60, phoneHourlyLimit: 5, phoneDailyLimit: 10,
  ipWindowSeconds: 600, ipWindowLimit: 20, systemDailyBudget: null, circuitOpen: false,
};

describe("PolicyService", () => {
  it("updates policy without resetting provider authorization", async () => {
    const readyConfig = {
      provider: "aliyun" as const, region: "cn-shanghai", accessKeyIdRef: "env://ACCESS_KEY_ID",
      accessKeySecretRef: "env://ACCESS_KEY_SECRET", receiptCallbackTokenRef: "env://CALLBACK_TOKEN",
      status: "ready" as const, enabled: true, lastTestStatus: "succeeded" as const, version: 8,
    };
    const store = {
      config: { get: async () => readyConfig },
      policy: {
        get: async () => defaultPolicy,
        update: async (input: typeof defaultPolicy & { expectedVersion: number }) => ({ ...input, version: 2 }),
      },
    };
    const policyService = new PolicyService({ store: store as never, authorizer: { assert: () => undefined } });
    const configService = new ConfigService({
      store: store as never, provider: {} as never, secretResolver: {} as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date() },
      ids: { next: () => "audit-1" }, events: { emit: () => undefined },
    });

    const updated = await policyService.update(actor, { ...defaultPolicy, expectedVersion: 1, systemDailyBudget: 500 });

    expect(updated.version).toBe(2);
    expect((await configService.get(actor)).status).toBe("ready");
  });

  it("rejects an open circuit without a reason before updating storage", async () => {
    let updates = 0;
    const service = new PolicyService({
      store: { policy: { get: async () => defaultPolicy, update: async () => { updates += 1; return defaultPolicy; } } } as never,
      authorizer: { assert: () => undefined },
    });

    await expect(service.update(actor, { ...defaultPolicy, expectedVersion: 1, circuitOpen: true }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID", fieldErrors: { circuitReason: ["invalid value"] } });

    expect(updates).toBe(0);
  });
});
