import type { CombinationPair, Result } from "./types.js";
export declare const MAX_DIMENSIONS = 5;
export declare const MAX_VALUES_PER_DIMENSION = 100;
export declare const MAX_COMBINATIONS = 100;
export declare const CNY_MAX_INTEGER_DIGITS = 16;
export declare const normalizeSpecificationLabel: (label: string) => string;
export declare const buildCombinationKey: (pairs: readonly CombinationPair[]) => string;
export declare const calculatePotentialCombinations: (valueCounts: readonly number[], maximum?: number) => {
    ok: true;
    count: number;
} | {
    ok: false;
    count: number;
};
export declare const validateCnyAmount: (amount: string) => Result<string>;
export declare const validateRegisteredSpuCode: (value: string) => Result<string>;
export declare const formatSkuCode: (registeredSpuCode: string, sequence: number) => Result<string>;
