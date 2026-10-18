import { SmsKitError } from "../core/errors.js";
function count(value, field) {
    if (value === undefined)
        return 0n;
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new SmsKitError("STORAGE_FAILURE", `${field} count is invalid`, true);
        }
        return BigInt(value);
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
        throw new SmsKitError("STORAGE_FAILURE", `${field} count is invalid`, true);
    }
    return BigInt(value);
}
function countDto(value) {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
/** A bounded diagnostic projection: operational rows remain tenant-scoped. */
export class HealthService {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async getSnapshot(input) {
        const now = this.dependencies.clock?.now() ?? new Date();
        const [config, policy, counts] = await Promise.all([
            this.dependencies.store.config.get(), this.dependencies.store.policy.get(), this.dependencies.store.health.snapshot({ tenantId: input.tenantId, now }),
        ]);
        const warnings = [];
        let status;
        if (config.status === "unconfigured") {
            status = "unconfigured";
            warnings.push("CONFIG_INVALID");
        }
        else if (!config.enabled || config.status === "disabled")
            status = "disabled";
        else if (config.status !== "ready" || policy.circuitOpen) {
            status = "degraded";
            if (policy.circuitOpen)
                warnings.push("CIRCUIT_OPEN");
        }
        else
            status = "ready";
        const heldBudgetCount = count(counts.heldBudgetCount, "held budget");
        // The policy bound keeps a nonnegative remainder safely representable as
        // a JSON number, while subtraction itself stays exact for corrupt/large
        // persisted held counts.
        const budgetRemaining = policy.systemDailyBudget === null
            ? null
            : Number(BigInt(policy.systemDailyBudget) > heldBudgetCount ? BigInt(policy.systemDailyBudget) - heldBudgetCount : 0n);
        if (counts.usableTemplates !== undefined && count(counts.usableTemplates, "usable templates") === 0n)
            warnings.push("TEMPLATE_UNAVAILABLE");
        const receiptCutoff = now.getTime() - (this.dependencies.receiptStaleMs ?? 60 * 60_000);
        if (count(counts.waitingMessages, "waiting messages") > 0n && counts.oldestWaitingAt !== undefined && counts.oldestWaitingAt.getTime() < receiptCutoff &&
            (counts.lastReceiptAt === undefined || counts.lastReceiptAt.getTime() < receiptCutoff))
            warnings.push("DELIVERY_UNKNOWN");
        if (counts.oldestPendingJobAt !== undefined && counts.oldestPendingJobAt.getTime() < now.getTime() - (this.dependencies.backlogStaleMs ?? 5 * 60_000))
            warnings.push("PROVIDER_UNAVAILABLE");
        if (budgetRemaining !== null && budgetRemaining <= Math.max(0, Math.floor(policy.systemDailyBudget * 0.1)))
            warnings.push("BUDGET_EXCEEDED");
        if (status === "ready" && warnings.length > 0)
            status = "degraded";
        return {
            tenantId: input.tenantId, status, providerStatus: config.status,
            ...(config.status === "unconfigured" || config.lastTestedAt === undefined ? {} : { lastConnectionTestAt: config.lastTestedAt }),
            ...(counts.lastReceiptAt === undefined ? {} : { lastReceiptAt: counts.lastReceiptAt }), pendingJobs: countDto(count(counts.pendingJobs, "pending jobs")),
            acceptanceUnknown: countDto(count(counts.acceptanceUnknown, "acceptance unknown")), finalUnknown: countDto(count(counts.finalUnknown, "delivery unknown final")),
            unmatchedReceipts: countDto(count(counts.unmatchedReceipts, "unmatched receipts")),
            systemBudgetRemaining: budgetRemaining,
            circuitOpen: policy.circuitOpen, warnings,
        };
    }
}
