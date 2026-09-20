import type { ConnectionInput, ConnectionSummary, ModelCapabilities, PlanInput, Plan } from "../types.js";
import type { AiKitOptions, AuthorizationRequest, ConnectionRecord } from "./contracts.js";
export declare function createManagement<C>(options: AiKitOptions<C>): {
    options: AiKitOptions<C>;
    limits: {
        maxInputCharacters: number;
        maxMessages: number;
        maxOutputTokens: number;
        maxOutputCharacters: number;
        maxResponseBytes: number;
        maxTimeoutMs: number;
        maxRetries: number;
    };
    summary: (c: ConnectionRecord) => ConnectionSummary;
    authorize: (ctx: C, request: AuthorizationRequest) => Promise<void>;
    gate: (ctx: C, request: AuthorizationRequest) => Promise<void>;
    adapter: (providerCode: string, protocol: string) => import("../types.js").ProviderAdapterInfo;
    capabilities: (providerCode: string, modelId: string) => Promise<ModelCapabilities>;
    validateConnection: (input: ConnectionInput, previous: ConnectionRecord | null, id: string) => Promise<ConnectionRecord>;
    listProviders(ctx: C): Promise<import("../types.js").DictionaryItem[]>;
    initializeDictionary(ctx: C): Promise<void>;
    listConnections(ctx: C): Promise<ConnectionSummary[]>;
    saveConnection(ctx: C, raw: ConnectionInput): Promise<ConnectionSummary>;
    deleteConnection(ctx: C, id: string, revision: number): Promise<void>;
    listPlans(ctx: C): Promise<Plan[]>;
    savePlan(ctx: C, raw: PlanInput): Promise<Plan>;
    setDefault(ctx: C, code: string | null): Promise<void>;
    listAuthorizedPlans(ctx: C): Promise<{
        code: string;
        name: string;
        modelId: string;
        providerCode: string;
        isDefault: boolean;
    }[]>;
};
export type Management<C> = ReturnType<typeof createManagement<C>>;
