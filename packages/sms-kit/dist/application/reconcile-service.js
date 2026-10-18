import { createHash } from "node:crypto";
import { SmsKitError } from "../core/errors.js";
const pageSize = 50;
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
function receiptKey(message, bizId, status, occurredAt) {
    return createHash("sha256").update("aliyun-query\0").update(message.id).update("\0").update(bizId).update("\0").update(status).update("\0").update(occurredAt.toISOString()).digest("hex");
}
function observe(events, event) {
    try {
        void Promise.resolve(events.emit(event)).catch(() => undefined);
    }
    catch { /* observability is non-authoritative */ }
}
/** Queries a previously uncertain dispatch only; it never calls the send endpoint. */
export class ReconcileService {
    dependencies;
    leaseMs;
    workerId;
    maxPagesPerMessage;
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.leaseMs = dependencies.leaseMs ?? 60_000;
        this.workerId = dependencies.workerId ?? "sms-reconcile";
        this.maxPagesPerMessage = dependencies.maxPagesPerMessage ?? 100;
        if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0 || !Number.isInteger(this.maxPagesPerMessage) || this.maxPagesPerMessage <= 0) {
            throw new RangeError("reconciliation lease and page limit must be positive");
        }
    }
    async runBatch(input) {
        if (!Number.isInteger(input.limit) || input.limit <= 0)
            throw new RangeError("reconciliation limit must be positive");
        const jobs = await this.dependencies.store.jobs.leaseReconciliation({ owner: this.workerId, limit: input.limit, leaseMs: this.leaseMs, now: this.dependencies.clock.now() });
        for (const job of jobs)
            await this.reconcile(job);
        return jobs.length;
    }
    async reconcile(job) {
        const leaseToken = job.leaseToken;
        if (job.messageId === undefined || leaseToken === undefined)
            return;
        const now = this.dependencies.clock.now();
        const message = await this.dependencies.store.messages.get({ tenantId: job.tenantId, id: job.messageId });
        if (message === undefined || message.deliveryStatus !== "waiting" || !["accepted", "unknown"].includes(message.acceptanceStatus)) {
            await this.dependencies.store.jobs.trySucceed({ tenantId: job.tenantId, id: job.id, leaseToken });
            return;
        }
        const attempts = await this.dependencies.store.attempts.listForMessage({ tenantId: job.tenantId, messageId: message.id });
        const dispatchAttempt = attempts[attempts.length - 1];
        if (dispatchAttempt === undefined || dispatchAttempt.status !== message.acceptanceStatus || !["accepted", "unknown"].includes(dispatchAttempt.status)) {
            await this.reschedule(job, "STORAGE_FAILURE");
            return;
        }
        if (!Number.isFinite(dispatchAttempt.dispatchMarkedAt.getTime()) || dispatchAttempt.dispatchMarkedAt.getTime() > now.getTime()) {
            await this.reschedule(job, "STORAGE_FAILURE");
            return;
        }
        const dispatchDate = shanghaiDate(dispatchAttempt.dispatchMarkedAt);
        const today = shanghaiDate(now);
        const ageInCalendarDays = today.dayNumber - dispatchDate.dayNumber;
        if (ageInCalendarDays < 0) {
            await this.reschedule(job, "STORAGE_FAILURE");
            return;
        }
        if (ageInCalendarDays >= 30) {
            await this.finalizeUnknown(job, message, now);
            return;
        }
        if (message.phoneCiphertext === undefined || message.phoneKeyId === undefined) {
            await this.reschedule(job, "STORAGE_FAILURE");
            return;
        }
        const config = await this.dependencies.store.config.get();
        if (config.status !== "ready" || !config.enabled) {
            await this.reschedule(job, "CONFIG_INVALID");
            return;
        }
        let phoneNumber;
        try {
            phoneNumber = await this.dependencies.phoneProtector.unprotect({ ciphertext: message.phoneCiphertext, keyId: message.phoneKeyId }, { envelopeVersion: 1, purpose: "phone", tenantId: message.tenantId, recordId: message.id, fieldName: "phone_ciphertext" });
        }
        catch {
            await this.reschedule(job, "STORAGE_FAILURE");
            return;
        }
        for (let currentPage = 1; currentPage <= this.maxPagesPerMessage; currentPage += 1) {
            const result = await this.dependencies.provider.queryDelivery({
                region: config.region, ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
                accessKeyId: config.accessKeyIdRef, accessKeySecret: config.accessKeySecretRef,
                phoneNumber, sendDate: dispatchDate.sendDate, currentPage, pageSize,
                ...(message.providerBizId === undefined ? {} : { bizId: message.providerBizId }),
            });
            if (result.kind === "unknown") {
                await this.reschedule(job, result.code);
                return;
            }
            // Alibaba may return details for nearby sends; never let a phone/date
            // match substitute for the persisted opaque OutId of this message.
            const item = result.items.find((candidate) => candidate.outId === message.id && candidate.status !== "waiting");
            if (item !== undefined && (item.status === "delivered" || item.status === "failed")) {
                const occurredAt = item.occurredAt ?? now;
                await this.recordResult(job, message, item.status, occurredAt, item.providerCode);
                return;
            }
            if (!result.hasNextPage) {
                await this.reschedule(job, "DELIVERY_UNKNOWN");
                return;
            }
        }
        // A malformed/infinite provider pagination sequence is non-authoritative.
        await this.reschedule(job, "DELIVERY_UNKNOWN");
    }
    async recordResult(job, message, status, occurredAt, providerCode) {
        const leaseToken = job.leaseToken;
        if (leaseToken === undefined)
            return;
        try {
            await this.dependencies.store.transaction(async (tx) => {
                // Fence before any durable receipt or state change. A reclaimed lease
                // rolls this whole transaction back rather than leaving stale effects.
                await this.dependencies.store.jobs.renew({ tenantId: job.tenantId, id: job.id, leaseToken, leaseMs: this.leaseMs, now: this.dependencies.clock.now() }, tx);
                // Query endpoints do not echo BizId. A receipt is only valid when the
                // queried message already has its provider reference; never invent one.
                {
                    await this.dependencies.store.receipts.record({
                        tenantId: message.tenantId, messageId: message.id, dedupeKey: receiptKey(message, message.providerBizId ?? message.id, status, occurredAt), ...(message.providerBizId === undefined ? { providerOutId: message.id } : { providerBizId: message.providerBizId }),
                        deliveryStatus: status, ...(providerCode === undefined ? {} : { providerCode }), occurredAt, receivedAt: this.dependencies.clock.now(), source: "query", redactedPayload: { redactedFields: ["phone"], reportCount: 1 },
                    }, tx);
                }
                await this.dependencies.store.messages.completeQueryDelivery({ tenantId: message.tenantId, id: message.id, status, occurredAt }, tx);
                await this.dependencies.store.jobs.succeed({ tenantId: job.tenantId, id: job.id, leaseToken }, tx);
            });
        }
        catch (error) {
            throw error;
        }
    }
    async finalizeUnknown(job, message, now) {
        try {
            await this.dependencies.store.transaction(async (tx) => {
                const leaseToken = job.leaseToken;
                if (leaseToken === undefined)
                    throw new SmsKitError("CONCURRENT_MODIFICATION", "reconciliation lease is missing");
                await this.dependencies.store.jobs.renew({ tenantId: job.tenantId, id: job.id, leaseToken, leaseMs: this.leaseMs, now: this.dependencies.clock.now() }, tx);
                await this.dependencies.store.messages.completeDelivery({ tenantId: message.tenantId, id: message.id, status: "unknown_final", occurredAt: now }, tx);
                await this.dependencies.store.jobs.succeed({ tenantId: job.tenantId, id: job.id, leaseToken }, tx);
            });
        }
        catch (error) {
            if (!(error instanceof SmsKitError) || error.code !== "CONCURRENT_MODIFICATION")
                throw error;
        }
    }
    async reschedule(job, code) {
        const changed = await this.dependencies.store.jobs.tryReschedule({ tenantId: job.tenantId, id: job.id, leaseToken: job.leaseToken, availableAt: new Date(this.dependencies.clock.now().getTime() + 5 * 60_000), errorCode: code });
        if (changed)
            observe(this.dependencies.events, { name: "sms.reconcile.deferred", level: "warn", code, tenantId: job.tenantId, metadata: { counts: [{ name: "job", value: 1 }] } });
    }
}
