import { createHash } from "node:crypto";
const millisecondsPerDay = 24 * 60 * 60 * 1_000;
function shanghaiDate(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(date);
    const value = (type) => parts.find((part) => part.type === type)?.value;
    const year = value("year");
    const month = value("month");
    const day = value("day");
    if (year === undefined || month === undefined || day === undefined)
        throw new RangeError("cannot derive Alibaba send date");
    return {
        sendDate: `${year}${month}${day}`,
        dayNumber: Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day)) / millisecondsPerDay),
    };
}
/** Queries SYSTEM messages after acceptance; it never calls the send endpoint. */
export class SystemAuthReconcileService {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async runBatch(input) {
        if (!Number.isInteger(input.limit) || input.limit <= 0)
            throw new RangeError("reconciliation limit must be positive");
        const leases = await this.dependencies.repository.leaseReconciliation({
            owner: "sms-system-reconcile",
            now: this.dependencies.clock.now(),
            limit: input.limit,
            leaseMs: 60_000,
        });
        for (const lease of leases)
            await this.reconcile(lease);
        return leases.length;
    }
    async reconcile(lease) {
        const now = this.dependencies.clock.now();
        if (lease.deliveryStatus !== "waiting") {
            await this.dependencies.store.transaction((tx) => this.dependencies.repository.finishTerminalReconciliation({ lease, occurredAt: now }, tx));
            return;
        }
        const dispatchDate = shanghaiDate(lease.dispatchMarkedAt);
        const age = shanghaiDate(now).dayNumber - dispatchDate.dayNumber;
        if (age >= 30) {
            await this.dependencies.store.transaction((tx) => this.dependencies.repository.finalizeUnknownReconciliation({ lease, occurredAt: now }, tx));
            return;
        }
        if (age < 0 || lease.phoneCiphertext === undefined || lease.phoneKeyId === undefined) {
            await this.reschedule(lease, "STORAGE_FAILURE");
            return;
        }
        const config = await this.dependencies.store.config.get();
        if (config.status !== "ready" || !config.enabled) {
            await this.reschedule(lease, "CONFIG_INVALID");
            return;
        }
        let phoneNumber;
        try {
            phoneNumber = await this.dependencies.phoneProtector.unprotect({ ciphertext: lease.phoneCiphertext, keyId: lease.phoneKeyId }, { envelopeVersion: 1, purpose: "phone", tenantId: null,
                recordId: lease.messageId, fieldName: "phone_ciphertext" });
        }
        catch {
            await this.reschedule(lease, "STORAGE_FAILURE");
            return;
        }
        for (let currentPage = 1; currentPage <= 100; currentPage += 1) {
            let result;
            try {
                result = await this.dependencies.provider.queryDelivery({
                    region: config.region,
                    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
                    accessKeyId: config.accessKeyIdRef,
                    accessKeySecret: config.accessKeySecretRef,
                    phoneNumber,
                    sendDate: dispatchDate.sendDate,
                    currentPage,
                    pageSize: 50,
                    ...(lease.providerBizId === undefined ? {} : { bizId: lease.providerBizId }),
                });
            }
            catch {
                await this.reschedule(lease, "DELIVERY_UNKNOWN");
                return;
            }
            if (result.kind === "unknown") {
                await this.reschedule(lease, result.code);
                return;
            }
            const item = result.items.find((candidate) => candidate.outId === lease.messageId &&
                (candidate.status === "delivered" || candidate.status === "failed"));
            if (item !== undefined && (item.status === "delivered" || item.status === "failed")) {
                const status = item.status;
                const occurredAt = item.occurredAt ?? this.dependencies.clock.now();
                const dedupeKey = createHash("sha256")
                    .update("aliyun-query\0").update(lease.messageId).update("\0")
                    .update(lease.providerBizId ?? lease.messageId).update("\0")
                    .update(status).update("\0").update(occurredAt.toISOString())
                    .digest("hex");
                await this.dependencies.store.transaction((tx) => this.dependencies.repository.completeQueryReconciliation({
                    lease,
                    status,
                    occurredAt,
                    receivedAt: this.dependencies.clock.now(),
                    dedupeKey,
                    ...(item.providerCode === undefined ? {} : { providerCode: item.providerCode }),
                }, tx));
                return;
            }
            if (!result.hasNextPage)
                break;
        }
        await this.reschedule(lease, "DELIVERY_UNKNOWN");
    }
    async reschedule(lease, errorCode) {
        await this.dependencies.repository.rescheduleReconciliation({
            lease,
            availableAt: new Date(this.dependencies.clock.now().getTime() + 5 * 60_000),
            errorCode,
        });
    }
}
