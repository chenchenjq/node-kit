/** Performs bounded, idempotent maintenance without deleting anonymous statistics. */
export class MaintenanceService {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async rollupDirtyDates(input) {
        if (!Number.isInteger(input.limit) || input.limit <= 0)
            throw new RangeError("rollup limit must be positive");
        return this.dependencies.store.stats.rollupDirtyDates({ limit: input.limit });
    }
    async applyRetention(input) {
        if (!Number.isInteger(input.batchSize) || input.batchSize <= 0)
            throw new RangeError("retention batch size must be positive");
        const now = this.dependencies.clock.now();
        const daysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
        return this.dependencies.store.maintenance.applyRetention({
            now, challengeBefore: daysAgo(7), messagePhoneBefore: daysAgo(90), receiptBefore: daysAgo(90), auditBefore: daysAgo(180), reservationBefore: daysAgo(90), batchSize: input.batchSize,
        });
    }
}
