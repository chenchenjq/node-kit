import type { StorageInput, StorageSummary, StrategyInput, Strategy, Credentials } from "../types.js";
export declare const MIME_BY_EXTENSION: Record<string, string>;
export declare function publicDomain(value: unknown): string | null;
export declare function validateStorage(input: StorageInput): Omit<StorageSummary, "id" | "isDefault" | "used" | "revision">;
export declare function validateCredentials(value: Credentials): Credentials;
export declare function validateStrategy(input: StrategyInput, maxBytes: number): Strategy;
