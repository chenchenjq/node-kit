import type { CombinationPair, InventoryAuthorityKind, Result, SkuImageReference, SkuProblem, SkuStatus } from "../types.js";
export type SkuAction = "consumer.read" | "management.read" | "supply-price.read" | "supply-price.write" | "structure.write" | "configuration.write" | "lifecycle.write" | "inventory.read" | "inventory.write" | "history.read";
export interface AuthorizationAllowed {
    ok: true;
}
export interface AuthorizationDenied {
    ok: false;
    problem?: SkuProblem;
}
export type AuthorizationResult = AuthorizationAllowed | AuthorizationDenied;
export interface SpecificationValueInput {
    id?: string;
    draftKey?: string;
    label: string;
    sort: number;
}
export interface SpecificationDimensionInput {
    id?: string;
    draftKey?: string;
    label: string;
    sort: number;
    values: readonly SpecificationValueInput[];
}
export interface SelectedCombinationInput {
    draftKey?: string;
    pairs: readonly CombinationPairInput[];
}
export interface CombinationPairInput {
    dimensionId?: string;
    valueId?: string;
    dimensionDraftKey?: string;
    valueDraftKey?: string;
}
export interface SaveConfigurationInput {
    spuId: string;
    spuCode: string;
    commandId: string;
    expectedStructureVersion?: string;
    dimensions: readonly SpecificationDimensionInput[];
    selectedCombinations: readonly SelectedCombinationInput[];
    restoreArchivedSkuIds?: readonly string[];
}
export interface SpuRefInput {
    spuId: string;
}
export interface PersistedDimension {
    id: string;
    label: string;
    normalizedLabel: string;
    sort: number;
    values: PersistedValue[];
    archived: boolean;
}
export interface PersistedValue {
    id: string;
    label: string;
    normalizedLabel: string;
    sort: number;
    archived: boolean;
}
export interface PersistedSku {
    id: string;
    skuCode: string;
    sequence: number;
    combinationKey: string;
    pairs: CombinationPair[];
    status: SkuStatus;
    suggestedRetailPrice: string | null;
    supplyPrice: string | null;
    image: SkuImageReference | null;
    configVersion: bigint;
    archived: boolean;
}
export interface CommandReceipt {
    commandId: string;
    fingerprint: string;
    result: unknown;
}
export interface ProductDocument {
    scopeKey: string;
    spuId: string;
    registeredSpuCode: string;
    structureVersion: bigint;
    nextSequence: number;
    dimensions: PersistedDimension[];
    skus: PersistedSku[];
    inventories: Record<string, {
        quantity: number;
        version: bigint;
    }>;
    commands: CommandReceipt[];
}
export interface SetLocalInventoryInput {
    spuId: string;
    skuId: string;
    commandId: string;
    expectedInventoryVersion: string;
    quantity: number;
}
export interface InventoryDto {
    skuId: string;
    quantity: number;
    inventoryVersion: string;
}
export type InventoryReadDto = {
    state: "known";
    skuId: string;
    quantity: number;
    inventoryVersion: string;
} | {
    state: "unknown";
    skuId: string;
    reason: string;
};
/** A scope's inventory authority is selected by the host, never inferred per SKU. */
export interface InventoryAuthority {
    kind: InventoryAuthorityKind;
    authorityKey: string;
}
export interface PreviewCombination {
    combinationKey: string;
    kind: "retained" | "added" | "archivable" | "restorable";
    skuId?: string;
    skuCode?: string;
}
export interface ConfigurationPreview {
    combinations: readonly PreviewCombination[];
    changesMode: boolean;
}
export interface SkuStore {
    transact<T>(scopeKey: string, spuId: string, callback: (current: ProductDocument | null) => Promise<{
        document?: ProductDocument;
        result: T;
    }> | {
        document?: ProductDocument;
        result: T;
    }): Promise<T>;
    read(scopeKey: string, spuId: string): Promise<ProductDocument | null>;
    findByRegisteredSpuCode?(scopeKey: string, registeredSpuCode: string): Promise<ProductDocument | null>;
    ensureInventoryAuthority?(scopeKey: string, authority: InventoryAuthority): Promise<Result<InventoryAuthority>>;
}
export interface SavedSku {
    skuId: string;
    skuCode: string;
    combinationKey: string;
    status: SkuStatus;
}
export interface SavedConfiguration {
    structureVersion: string;
    skus: SavedSku[];
    draftKeyMappings: Readonly<Record<string, string>>;
}
export interface ManagementConfiguration {
    currency: "CNY";
    spuId: string;
    registeredSpuCode: string;
    structureVersion: string;
    dimensions: readonly PersistedDimension[];
    /** Supply price is omitted unless the caller has supply-price.read. */
    skus: readonly (Omit<PersistedSku, "supplyPrice"> & {
        supplyPrice?: string | null;
    })[];
}
export interface HistoricalConfiguration {
    currency: "CNY";
    spuId: string;
    registeredSpuCode: string;
    archivedSkus: readonly PersistedSku[];
}
export interface SkuConfigurationPatch {
    skuId: string;
    expectedConfigVersion: string;
    suggestedRetailPrice?: string | null;
    supplyPrice?: string | null;
    image?: SkuImageReference | null;
    status?: "disabled" | "enabled";
}
export interface PatchSkuConfigurationsInput {
    spuId: string;
    commandId: string;
    expectedStructureVersion?: string;
    patches: readonly SkuConfigurationPatch[];
}
export interface CopySkuConfigurationInput {
    spuId: string;
    commandId: string;
    sourceSkuId: string;
    targetSkuIds: readonly string[];
    fields: readonly ("suggestedRetailPrice" | "supplyPrice" | "image")[];
    mode: "empty-only" | "overwrite";
}
export interface SkuConfigurationDto {
    currency: "CNY";
    skuId: string;
    skuCode: string;
    status: "disabled" | "enabled" | "archived";
    suggestedRetailPrice: string | null;
    supplyPrice: string | null;
    image: SkuImageReference | null;
    configVersion: string;
}
export interface ConsumerProjection {
    skuId: string;
    visible: boolean;
    selectable: boolean;
    salePrice: string | null;
    availability: string;
}
export interface ConsumerSelectionInput extends SpuRefInput {
    selectedValueIds: readonly string[];
    spuImage?: SkuImageReference | null;
}
export interface ConsumerOption {
    valueId: string;
    label: string;
    state: "selected" | "selectable" | "out-of-stock" | "unavailable" | "impossible";
}
export interface ConsumerSelectionDto {
    currency: "CNY";
    dimensions: readonly {
        dimensionId: string;
        label: string;
        options: readonly ConsumerOption[];
    }[];
    selectedSku: {
        skuId: string;
        skuCode: string;
        salePrice: string | null;
        availability: string;
    } | null;
    image: SkuImageReference | null;
    priceRange: {
        status: "complete" | "partial" | "unknown";
        min: string | null;
        max: string | null;
    };
}
export interface SkuService<RequestContext> {
    previewConfiguration(context: RequestContext, input: Omit<SaveConfigurationInput, "commandId" | "expectedStructureVersion" | "restoreArchivedSkuIds">): Promise<Result<ConfigurationPreview>>;
    saveConfiguration(context: RequestContext, input: SaveConfigurationInput): Promise<Result<SavedConfiguration>>;
    patchSkuConfigurations(context: RequestContext, input: PatchSkuConfigurationsInput): Promise<Result<readonly SkuConfigurationDto[]>>;
    copySkuConfiguration(context: RequestContext, input: CopySkuConfigurationInput): Promise<Result<readonly SkuConfigurationDto[]>>;
    getManagementConfiguration(context: RequestContext, input: SpuRefInput): Promise<Result<ManagementConfiguration>>;
    getHistoricalConfiguration(context: RequestContext, input: SpuRefInput): Promise<Result<HistoricalConfiguration>>;
    getConsumerSelection(context: RequestContext, input: ConsumerSelectionInput): Promise<Result<ConsumerSelectionDto>>;
    getInventory(context: RequestContext, input: SpuRefInput & {
        skuId: string;
    }): Promise<Result<InventoryReadDto>>;
    setLocalInventory(context: RequestContext, input: SetLocalInventoryInput): Promise<Result<InventoryDto>>;
    setExternalInventory(context: RequestContext, input: SetLocalInventoryInput): Promise<Result<InventoryDto>>;
}
