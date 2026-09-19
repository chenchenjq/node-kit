import type { AuthorizationResult, ConsumerProjection, InventoryAuthority, PersistedSku, SkuAction, SkuService, SkuStore } from "./contracts.js";
export interface CreateSkuServiceOptions<RequestContext> {
    store: SkuStore;
    resolveScope(context: RequestContext): Promise<string>;
    authorize(context: RequestContext, action: SkuAction, resource: {
        spuId: string;
    }): Promise<AuthorizationResult>;
    projectConsumer?(skus: readonly PersistedSku[]): Promise<readonly ConsumerProjection[]>;
    resolveInventoryAuthority?(context: RequestContext, scopeKey: string): Promise<InventoryAuthority>;
    createId?: () => string;
}
export declare const createSkuService: <RequestContext>(options: CreateSkuServiceOptions<RequestContext>) => SkuService<RequestContext>;
