import type { Clock } from "../ports/runtime.js";
import type { SmsStore } from "../ports/store.js";

export type MaintenanceServiceDependencies = Readonly<{ store: SmsStore; clock: Clock }>;
export type RollupDirtyDatesInput = Readonly<{ limit: number }>;
export type ApplyRetentionInput = Readonly<{ batchSize: number }>;

/** Performs bounded, idempotent maintenance without deleting anonymous statistics. */
export class MaintenanceService {
  constructor(private readonly dependencies: MaintenanceServiceDependencies) {}

  async rollupDirtyDates(input: RollupDirtyDatesInput): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) throw new RangeError("rollup limit must be positive");
    return this.dependencies.store.stats.rollupDirtyDates({ limit: input.limit });
  }

  async applyRetention(input: ApplyRetentionInput): Promise<number> {
    if (!Number.isInteger(input.batchSize) || input.batchSize <= 0) throw new RangeError("retention batch size must be positive");
    const now = this.dependencies.clock.now();
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
    return this.dependencies.store.maintenance.applyRetention({
      now, challengeBefore: daysAgo(7), messagePhoneBefore: daysAgo(90), receiptBefore: daysAgo(90), auditBefore: daysAgo(180), reservationBefore: daysAgo(90), batchSize: input.batchSize,
    });
  }
}
