import type { Result } from "../types.js";
import type { AuthorizationResult, ConsumerProjection, InventoryAuthority, InventoryDto, InventoryReadDto, PersistedSku, ProductDocument, SetLocalInventoryInput, SkuAction, SkuService, SkuStore } from "./contracts.js";
export interface CreateSkuServiceOptions<RequestContext> {
    store: SkuStore;
    resolveScope(context: RequestContext): Promise<string>;
    authorize(context: RequestContext, action: SkuAction, resource: {
        spuId: string;
    }): Promise<AuthorizationResult>;
    projectConsumer?(skus: readonly PersistedSku[]): Promise<readonly ConsumerProjection[]>;
    resolveInventoryAuthority?(context: RequestContext, scopeKey: string): Promise<InventoryAuthority>;
    approveModeChange?(context: RequestContext, change: {
        spuId: string;
        from: "default" | "multi";
        to: "default" | "multi";
        document: ProductDocument;
    }): Promise<Result<true>>;
    readExternalInventory?(context: RequestContext, request: {
        scopeKey: string;
        spuId: string;
        skuId: string;
        authority: InventoryAuthority;
    }): Promise<Result<InventoryReadDto>>;
    setExternalInventory?(context: RequestContext, request: SetLocalInventoryInput & {
        scopeKey: string;
        authority: InventoryAuthority;
    }): Promise<Result<InventoryDto>>;
    createId?: () => string;
}
export declare const createSkuService: <RequestContext>(options: CreateSkuServiceOptions<RequestContext>) => SkuService<RequestContext>;
