import type { SmsErrorCode } from "../core/errors.js";
import type { TenantId } from "../core/types.js";
import type { SmsStore } from "../ports/store.js";

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
export type HealthServiceDependencies = Readonly<{ store: SmsStore }>;

/** A bounded diagnostic projection: operational rows remain tenant-scoped. */
export class HealthService {
  constructor(private readonly dependencies: HealthServiceDependencies) {}

  async getSnapshot(input: Readonly<{ tenantId: TenantId }>): Promise<SmsHealthSnapshot> {
    const now = new Date();
    const [config, policy, counts] = await Promise.all([
      this.dependencies.store.config.get(), this.dependencies.store.policy.get(), this.dependencies.store.health.snapshot({ tenantId: input.tenantId, now }),
    ]);
    const warnings: SmsErrorCode[] = [];
    let status: SmsHealthSnapshot["status"];
    if (config.status === "unconfigured") { status = "unconfigured"; warnings.push("CONFIG_INVALID"); }
    else if (!config.enabled || config.status === "disabled") status = "disabled";
    else if (config.status !== "ready" || policy.circuitOpen) { status = "degraded"; if (policy.circuitOpen) warnings.push("CIRCUIT_OPEN"); }
    else status = "ready";
    return {
      tenantId: input.tenantId, status, ...(config.status === "unconfigured" || config.lastTestedAt === undefined ? {} : { lastConnectionTestAt: config.lastTestedAt }),
      ...(counts.lastReceiptAt === undefined ? {} : { lastReceiptAt: counts.lastReceiptAt }), pendingJobs: counts.pendingJobs,
      acceptanceUnknown: counts.acceptanceUnknown, finalUnknown: counts.finalUnknown, unmatchedReceipts: counts.unmatchedReceipts,
      systemBudgetRemaining: policy.systemDailyBudget === null ? null : Math.max(0, policy.systemDailyBudget - (counts.heldBudgetCount ?? 0)),
      circuitOpen: policy.circuitOpen, warnings,
    };
  }
}
