import type { CallInput, ConnectionInput, ConnectionSummary, DictionaryPort, GenerationParameters, GenerationResult, ModelCapabilities, Plan, PlanInput, PlanSummary, SafeError, StreamEvent, TestDraft, TestResult, Usage } from "../types.js";
import type { TransportDependencies } from "./network.js";
/** Persist only protected values. binding includes the trusted host scope and connection ID. */
export interface SecretProtector {
    seal(secret: string, binding: string): Promise<string>;
    open(envelope: string, binding: string): Promise<string>;
}
export interface ConnectionRecord extends Omit<ConnectionSummary, "hasCredential"> {
    credentialEnvelope: string;
}
export interface StoreView {
    getConnection(id: string): Promise<ConnectionRecord | null>;
    listConnections(): Promise<ConnectionRecord[]>;
    saveConnection(record: ConnectionRecord): Promise<void>;
    deleteConnection(id: string): Promise<void>;
    getPlan(code: string): Promise<Plan | null>;
    listPlans(): Promise<Plan[]>;
    savePlan(plan: Plan): Promise<void>;
}
export interface AiStore {
    /** read must run work inside one consistent snapshot, scoped by the host. */
    read<T>(work: (view: StoreView) => Promise<T>): Promise<T>;
    /** serializes all same-scope writers across processes; rolls back on failure. */
    transaction<T>(work: (view: StoreView) => Promise<T>): Promise<T>;
}
export type AuthorizationRequest = {
    action: "admin" | "test" | "dictionary";
} | {
    action: "query" | "generate" | "override" | "system";
    code: string;
};
export interface HostLimits {
    maxInputCharacters: number;
    maxMessages: number;
    maxOutputTokens: number;
    maxOutputCharacters: number;
    maxResponseBytes: number;
    maxTimeoutMs: number;
    maxRetries: number;
}
export interface LogMetadata {
    status: string;
    code: string;
    providerCode: string;
    modelId: string;
    durationMs: number;
    usage: Usage | null;
}
export interface AiKitOptions<Context> {
    scope: string;
    store: AiStore;
    dictionary: DictionaryPort;
    secrets: SecretProtector;
    authorize(ctx: Context, request: AuthorizationRequest): Promise<boolean>;
    /** Host must implement an atomic, shared limiter. Every public operation passes this gate. */
    rateLimit(ctx: Context, action: AuthorizationRequest["action"]): Promise<boolean>;
    allowURL(url: URL): Promise<boolean>;
    limits?: Partial<HostLimits>;
    resolveModelCapabilities?(providerCode: string, modelId: string): Promise<ModelCapabilities | null>;
    log?(metadata: LogMetadata): void;
    /** Trusted bootstrap network seam for Mock tests only; never accept from HTTP inputs. */
    transport?: TransportDependencies;
}
export interface AiKit<Context> {
    listProviders(ctx: Context): Promise<import("../types.js").DictionaryItem[]>;
    initializeDictionary(ctx: Context): Promise<void>;
    listConnections(ctx: Context): Promise<ConnectionSummary[]>;
    saveConnection(ctx: Context, input: ConnectionInput): Promise<ConnectionSummary>;
    deleteConnection(ctx: Context, id: string, revision: number): Promise<void>;
    listPlans(ctx: Context): Promise<Plan[]>;
    savePlan(ctx: Context, input: PlanInput): Promise<Plan>;
    setDefault(ctx: Context, code: string | null): Promise<void>;
    listAuthorizedPlans(ctx: Context): Promise<PlanSummary[]>;
    generate(ctx: Context, input: CallInput): Promise<GenerationResult>;
    stream(ctx: Context, input: CallInput): AsyncIterable<StreamEvent>;
    testPlan(ctx: Context, code: string, signal?: AbortSignal): Promise<TestResult>;
    testDraft(ctx: Context, input: TestDraft, signal?: AbortSignal): Promise<TestResult>;
    refreshModels(ctx: Context, connectionId: string, signal?: AbortSignal): Promise<string[]>;
}
export interface Snapshot {
    connection: ConnectionRecord;
    plan: Plan;
    parameters: {
        maxOutputTokens: number;
        timeoutMs: number;
        maxRetries: number;
    } & GenerationParameters;
    input: CallInput;
}
export type { SafeError };
