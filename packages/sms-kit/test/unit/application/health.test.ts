import { describe, expect, it } from "vitest";

import { HealthService } from "../../../src/application/health-service.js";
import type { TenantId } from "../../../src/core/types.js";

describe("HealthService", () => {
  it("returns bounded redacted tenant health with system policy state", async () => {
    const tenantId = "health-tenant" as TenantId;
    const health = new HealthService({
      store: {
        health: {
          snapshot: async () => ({ pendingJobs: 2, acceptanceUnknown: 1, finalUnknown: 3, unmatchedReceipts: 4, lastReceiptAt: new Date("2026-09-14T00:00:00.000Z") }),
        },
        config: { get: async () => ({ provider: "aliyun", status: "ready", enabled: true, region: "cn", accessKeyIdRef: "secret-id", accessKeySecretRef: "secret-value", receiptCallbackTokenRef: "callback", lastTestStatus: "succeeded", lastTestedAt: new Date("2026-09-14T00:00:00.000Z"), version: 1 }) },
        policy: { get: async () => ({ systemDailyBudget: 10, circuitOpen: false }) },
      } as never,
    });

    await expect(health.getSnapshot({ tenantId })).resolves.toEqual({
      tenantId, status: "ready", lastConnectionTestAt: new Date("2026-09-14T00:00:00.000Z"), lastReceiptAt: new Date("2026-09-14T00:00:00.000Z"),
      pendingJobs: 2, acceptanceUnknown: 1, finalUnknown: 3, unmatchedReceipts: 4, systemBudgetRemaining: 10, circuitOpen: false, warnings: [],
    });
  });
});
