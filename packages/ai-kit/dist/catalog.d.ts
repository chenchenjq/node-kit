import type { DictionaryPort, DictionaryItem, ModelPreset, ProviderAdapterInfo } from "./types.js";
export declare const providerDictionaryType = "ai_model_provider";
export declare const providerSeeds: readonly DictionaryItem[];
/** The host must enforce unique(type,code) and insert-if-absent atomically. */
export declare function seedProviderDictionary(port: DictionaryPort): Promise<void>;
export declare const providerAdapters: readonly ProviderAdapterInfo[];
export declare const modelPresets: readonly ModelPreset[];
