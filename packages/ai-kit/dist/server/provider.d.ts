import type { LanguageModel, generateText } from "ai";
type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;
import type { ConnectionRecord, Snapshot } from "./contracts.js";
export declare function buildProvider(connection: ConnectionRecord, modelId: string, key: string, fetch: typeof globalThis.fetch, parameters: Snapshot["parameters"]): {
    model: LanguageModel;
    providerOptions: ProviderOptions;
};
export {};
