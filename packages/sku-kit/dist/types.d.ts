export type SkuStatus = "disabled" | "enabled" | "archived";
export type InventoryAuthorityKind = "local-read-write" | "external-read-write" | "external-read-only";
export type PriceRangeStatus = "complete" | "partial" | "unknown";
export type SkuProblemCode = "VALIDATION_FAILED" | "NOT_FOUND" | "FORBIDDEN" | "SCOPE_MISMATCH" | "SPU_CODE_CONFLICT" | "SPU_CODE_MISMATCH" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "COMBINATION_CONFLICT" | "CAPACITY_EXHAUSTED" | "RESTORE_REQUIRED" | "TRANSITION_BLOCKED" | "INVENTORY_UNKNOWN" | "INVENTORY_READ_ONLY" | "INVENTORY_AUTHORITY_MISMATCH" | "ADAPTER_FAILURE";
export interface SkuProblem {
    code: SkuProblemCode;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
}
export type Result<T> = {
    ok: true;
    value: T;
    warnings?: readonly SkuWarning[];
} | {
    ok: false;
    problem: SkuProblem;
};
export interface SkuWarning {
    code: "SUPPLY_PRICE_ABOVE_RETAIL";
    message: string;
}
export interface CombinationPair {
    dimensionId: string;
    valueId: string;
}
export interface SkuImageReference {
    adapter: string;
    value: string;
}
export interface PresetValue {
    label: string;
    sort: number;
}
export interface SpecificationPreset {
    id: string;
    label: string;
    values: readonly PresetValue[];
}
export declare const BUILTIN_PRESETS: readonly SpecificationPreset[];
