import { describe, expect, it } from "vitest";

import { HealthService } from "../../../src/application/health-service.js";
import type { TenantId } from "../../../src/core/types.js";
import { PgHealthRepository } from "../../../src/postgres/repositories/health-repository.js";

describe("HealthService", () => {
  it("uses the injected UTC day and degrades for resource, receipt, backlog and budget problems", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    let seen: Date | undefined;
    const service = new HealthService({
      clock: { now: () => now },
      store: {
        config: { get: async () => ({ status: "ready", enabled: true, lastTestStatus: "succeeded" }) },
        policy: { get: async () => ({ systemDailyBudget: 2, circuitOpen: false }) },
        health: { snapshot: async (input: { now: Date }) => { seen = input.now; return { pendingJobs: 1, oldestPendingJobAt: new Date("2026-09-13"), waitingMessages: 1, oldestWaitingAt: new Date("2026-09-13"), usableTemplates: 0, acceptanceUnknown: 0, finalUnknown: 0, unmatchedReceipts: 0, heldBudgetCount: 2 }; } },
      } as never,
    });
    const result = await service.getSnapshot({ tenantId: "health-tenant" as never });
    expect(seen).toEqual(now);
    expect(result.status).toBe("degraded");
    expect(result.warnings).toEqual(expect.arrayContaining(["TEMPLATE_UNAVAILABLE", "DELIVERY_UNKNOWN", "PROVIDER_UNAVAILABLE", "BUDGET_EXCEEDED"]));
  });
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
      tenantId, status: "ready", providerStatus: "ready", lastConnectionTestAt: new Date("2026-09-14T00:00:00.000Z"), lastReceiptAt: new Date("2026-09-14T00:00:00.000Z"),
      pendingJobs: 2, acceptanceUnknown: 1, finalUnknown: 3, unmatchedReceipts: 4, systemBudgetRemaining: 10, circuitOpen: false, warnings: [],
    });
  });

  it("preserves PostgreSQL counters beyond JavaScript's safe integer range", async () => {
    const large = "9007199254740993";
    const repository = new PgHealthRepository({
      query: async () => ({ rows: [{
        pending_jobs: large,
        acceptance_unknown: large,
        final_unknown: large,
        unmatched_receipts: large,
        held_budget_count: "0",
        usable_templates: "1",
        waiting_messages: "0",
        oldest_waiting_at: null,
        oldest_pending_job_at: null,
        last_receipt_at: null,
      }] }),
    } as never);
    const health = new HealthService({
      store: {
        health: repository,
        config: { get: async () => ({ provider: "aliyun", status: "ready", enabled: true, region: "cn", accessKeyIdRef: "secret-id", accessKeySecretRef: "secret-value", receiptCallbackTokenRef: "callback", lastTestStatus: "succeeded", version: 1 }) },
        policy: { get: async () => ({ systemDailyBudget: null, circuitOpen: false }) },
      } as never,
    });

    await expect(health.getSnapshot({ tenantId: "health-large" as TenantId })).resolves.toMatchObject({
      pendingJobs: large,
      acceptanceUnknown: large,
      finalUnknown: large,
      unmatchedReceipts: large,
    });
  });
});
