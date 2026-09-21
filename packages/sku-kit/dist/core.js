export const MAX_DIMENSIONS = 5;
export const MAX_VALUES_PER_DIMENSION = 100;
export const MAX_COMBINATIONS = 100;
export const CNY_MAX_INTEGER_DIGITS = 16;
const validationFailure = (message, details) => ({
    code: "VALIDATION_FAILED",
    message,
    retryable: false,
    ...(details === undefined ? {} : { details }),
});
export const normalizeSpecificationLabel = (label) => label.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
export const buildCombinationKey = (pairs) => {
    const sorted = [...pairs]
        .map(({ dimensionId, valueId }) => [dimensionId, valueId])
        .sort(([left], [right]) => left.localeCompare(right));
    return `v1:${JSON.stringify(sorted)}`;
};
export const calculatePotentialCombinations = (valueCounts, maximum = MAX_COMBINATIONS) => {
    let count = 1;
    for (const valueCount of valueCounts) {
        count *= valueCount;
        if (count > maximum)
            return { ok: false, count };
    }
    return { ok: true, count };
};
export const validateCnyAmount = (amount) => {
    if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(amount)) {
        return { ok: false, problem: validationFailure("金额必须是最多两位小数的非负十进制字符串") };
    }
    const [integer, fractional = ""] = amount.split(".");
    if (integer === undefined || integer.length > CNY_MAX_INTEGER_DIGITS) {
        return { ok: false, problem: validationFailure("金额超出范围") };
    }
    return { ok: true, value: `${integer}.${fractional.padEnd(2, "0")}` };
};
export const validateRegisteredSpuCode = (value) => {
    if (value.length < 1 || value.length > 126 || value.trim() !== value || /[\u0000-\u001F\u007F]/u.test(value)) {
        return { ok: false, problem: validationFailure("SPU 编码必须是 1 至 126 个非空白、非控制字符") };
    }
    return { ok: true, value };
};
export const formatSkuCode = (registeredSpuCode, sequence) => {
    const validated = validateRegisteredSpuCode(registeredSpuCode);
    if (!validated.ok)
        return validated;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > 99) {
        return { ok: false, problem: validationFailure("SKU 序号必须在 00 到 99 之间") };
    }
    return { ok: true, value: `${registeredSpuCode}${String(sequence).padStart(2, "0")}` };
};
