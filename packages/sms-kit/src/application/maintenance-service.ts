import type { Clock } from "../ports/runtime.js";
import type { SmsStore } from "../ports/store.js";

export type MaintenanceServiceDependencies = Readonly<{ store: SmsStore; clock: Clock; retentionDays?: number }>;
export type RollupDirtyDatesInput = Readonly<{ limit: number }>;
export type ApplyRetentionInput = Readonly<{ batchSize: number }>;

/** Performs bounded, idempotent maintenance without deleting anonymous statistics. */
export class MaintenanceService {
  private readonly retentionMs: number;

  constructor(private readonly dependencies: MaintenanceServiceDependencies) {
    const days = dependencies.retentionDays ?? 30;
    if (!Number.isInteger(days) || days <= 0) throw new RangeError("retention days must be a positive integer");
    this.retentionMs = days * 24 * 60 * 60 * 1_000;
  }

  async rollupDirtyDates(input: RollupDirtyDatesInput): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) throw new RangeError("rollup limit must be positive");
    return this.dependencies.store.stats.rollupDirtyDates({ limit: input.limit });
  }

  async applyRetention(input: ApplyRetentionInput): Promise<number> {
    if (!Number.isInteger(input.batchSize) || input.batchSize <= 0) throw new RangeError("retention batch size must be positive");
    return this.dependencies.store.maintenance.applyRetention({ before: new Date(this.dependencies.clock.now().getTime() - this.retentionMs), batchSize: input.batchSize });
  }
}
