const redactedFields = new Set(["phone", "otp", "proof", "secret", "template-params"]);
const metricNames = new Set(["attempt", "job", "message", "receipt", "resource", "rate-limit", "signature", "template"]);
/** Projects untrusted diagnostics to the finite persistence-safe metadata schema. */
export function projectSafeEventMetadata(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return {};
    const source = input;
    const safeFields = Array.isArray(source.redactedFields)
        ? source.redactedFields.filter((field) => typeof field === "string" && redactedFields.has(field))
        : [];
    const safeCounts = Array.isArray(source.counts)
        ? source.counts.flatMap((count) => {
            if (typeof count !== "object" || count === null || Array.isArray(count))
                return [];
            const value = count;
            return typeof value.name === "string" && metricNames.has(value.name) &&
                typeof value.value === "number" && Number.isFinite(value.value)
                ? [{ name: value.name, value: value.value }]
                : [];
        })
        : [];
    return {
        ...(safeFields.length === 0 ? {} : { redactedFields: safeFields }),
        ...(safeCounts.length === 0 ? {} : { counts: safeCounts }),
    };
}
/** Projects callback diagnostics before they enter JSONB, discarding nested or unknown values. */
export function projectSafeReceiptPayload(input) {
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return { redactedFields: [] };
    const source = input;
    const safeFields = Array.isArray(source.redactedFields)
        ? source.redactedFields.filter((field) => typeof field === "string" && redactedFields.has(field))
        : [];
    const reportCount = typeof source.reportCount === "number" && Number.isFinite(source.reportCount) && source.reportCount >= 0
        ? source.reportCount
        : undefined;
    return { redactedFields: safeFields, ...(reportCount === undefined ? {} : { reportCount }) };
}
export class FixedTenantContext {
    tenantId;
    constructor(tenantId) {
        this.tenantId = tenantId;
    }
    resolve(_input) {
        return this.tenantId;
    }
}
