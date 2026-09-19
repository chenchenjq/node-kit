export type SkuStatus = "disabled" | "enabled" | "archived";
export type InventoryAuthorityKind = "local-read-write" | "external-read-write" | "external-read-only";
export type PriceRangeStatus = "complete" | "partial" | "unknown";

export type SkuProblemCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "SCOPE_MISMATCH"
  | "SPU_CODE_CONFLICT"
  | "SPU_CODE_MISMATCH"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "COMBINATION_CONFLICT"
  | "CAPACITY_EXHAUSTED"
  | "RESTORE_REQUIRED"
  | "TRANSITION_BLOCKED"
  | "INVENTORY_UNKNOWN"
  | "INVENTORY_READ_ONLY"
  | "INVENTORY_AUTHORITY_MISMATCH"
  | "ADAPTER_FAILURE";

export interface SkuProblem {
  code: SkuProblemCode;
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, unknown>>;
}

export type Result<T> =
  | { ok: true; value: T; warnings?: readonly SkuWarning[] }
  | { ok: false; problem: SkuProblem };

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

export const BUILTIN_PRESETS: readonly SpecificationPreset[] = [
  { id: "builtin:color", label: "颜色", values: [{ label: "红色", sort: 0 }, { label: "蓝色", sort: 1 }] },
  { id: "builtin:size", label: "尺码", values: [{ label: "S", sort: 0 }, { label: "M", sort: 1 }, { label: "L", sort: 2 }] },
  { id: "builtin:dimension", label: "尺寸", values: [{ label: "10×20cm", sort: 0 }, { label: "20×30cm", sort: 1 }] },
  { id: "builtin:weight", label: "重量", values: [{ label: "500g", sort: 0 }, { label: "1kg", sort: 1 }] },
];
