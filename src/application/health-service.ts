import type { SmsErrorCode } from "../core/errors.js";
import type { TenantId } from "../core/types.js";
import type { SmsStore } from "../ports/store.js";
import type { Clock } from "../ports/runtime.js";

export type SmsHealthSnapshot = Readonly<{
  tenantId: TenantId;
  status: "ready" | "degraded" | "disabled" | "unconfigured";
  lastConnectionTestAt?: Date;
  lastReceiptAt?: Date;
  pendingJobs: number;
  acceptanceUnknown: number;
  finalUnknown: number;
  unmatchedReceipts: number;
  systemBudgetRemaining: number | null;
  circuitOpen: boolean;
  warnings: readonly SmsErrorCode[];
}>;
export type HealthServiceDependencies = Readonly<{ store: SmsStore; clock?: Clock; receiptStaleMs?: number; backlogStaleMs?: number }>;

/** A bounded diagnostic projection: operational rows remain tenant-scoped. */
export class HealthService {
  constructor(private readonly dependencies: HealthServiceDependencies) {}

  async getSnapshot(input: Readonly<{ tenantId: TenantId }>): Promise<SmsHealthSnapshot> {
    const now = this.dependencies.clock?.now() ?? new Date();
    const [config, policy, counts] = await Promise.all([
      this.dependencies.store.config.get(), this.dependencies.store.policy.get(), this.dependencies.store.health.snapshot({ tenantId: input.tenantId, now }),
    ]);
    const warnings: SmsErrorCode[] = [];
    let status: SmsHealthSnapshot["status"];
    if (config.status === "unconfigured") { status = "unconfigured"; warnings.push("CONFIG_INVALID"); }
    else if (!config.enabled || config.status === "disabled") status = "disabled";
    else if (config.status !== "ready" || policy.circuitOpen) { status = "degraded"; if (policy.circuitOpen) warnings.push("CIRCUIT_OPEN"); }
    else status = "ready";
    const budgetRemaining = policy.systemDailyBudget === null ? null : Math.max(0, policy.systemDailyBudget - (counts.heldBudgetCount ?? 0));
    if (counts.usableTemplates === 0) warnings.push("TEMPLATE_UNAVAILABLE");
    const receiptCutoff = now.getTime() - (this.dependencies.receiptStaleMs ?? 60 * 60_000);
    if ((counts.waitingMessages ?? 0) > 0 && counts.oldestWaitingAt !== undefined && counts.oldestWaitingAt.getTime() < receiptCutoff &&
        (counts.lastReceiptAt === undefined || counts.lastReceiptAt.getTime() < receiptCutoff)) warnings.push("DELIVERY_UNKNOWN");
    if (counts.oldestPendingJobAt !== undefined && counts.oldestPendingJobAt.getTime() < now.getTime() - (this.dependencies.backlogStaleMs ?? 5 * 60_000)) warnings.push("PROVIDER_UNAVAILABLE");
    if (budgetRemaining !== null && budgetRemaining <= Math.max(0, Math.floor(policy.systemDailyBudget! * 0.1))) warnings.push("BUDGET_EXCEEDED");
    if (status === "ready" && warnings.length > 0) status = "degraded";
    return {
      tenantId: input.tenantId, status, ...(config.status === "unconfigured" || config.lastTestedAt === undefined ? {} : { lastConnectionTestAt: config.lastTestedAt }),
      ...(counts.lastReceiptAt === undefined ? {} : { lastReceiptAt: counts.lastReceiptAt }), pendingJobs: counts.pendingJobs,
      acceptanceUnknown: counts.acceptanceUnknown, finalUnknown: counts.finalUnknown, unmatchedReceipts: counts.unmatchedReceipts,
      systemBudgetRemaining: budgetRemaining,
      circuitOpen: policy.circuitOpen, warnings,
    };
  }
}
