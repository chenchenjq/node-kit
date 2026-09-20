/** Browser-safe contracts. No provider SDK or secret implementation is exported here. */
export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export interface DictionaryItem {
    code: string;
    name: string;
    sort: number;
    enabled: boolean;
}
export interface DictionaryPort {
    insertTypeIfAbsent(type: string, name: string): Promise<void>;
    insertItemIfAbsent(type: string, item: DictionaryItem): Promise<void>;
    listItems(type: string): Promise<DictionaryItem[]>;
}
export interface GenerationParameters {
    temperature?: number | undefined;
    topP?: number | undefined;
    maxOutputTokens?: number | undefined;
    timeoutMs?: number | undefined;
    maxRetries?: number | undefined;
    thinking?: "enabled" | "disabled" | undefined;
}
export interface ConnectionInput {
    id?: string | undefined;
    revision?: number | undefined;
    name: string;
    providerCode: string;
    protocol: Protocol;
    baseURL: string;
    apiKey?: string | undefined;
    enabled: boolean;
    /** Required when a saved credential would be sent to a new origin/provider. */
    confirmKeyDomainChange?: boolean | undefined;
    /** Disabling a default connection must explicitly clear its default plan. */
    clearDefault?: boolean | undefined;
}
export interface ConnectionSummary {
    id: string;
    name: string;
    providerCode: string;
    protocol: Protocol;
    baseURL: string;
    enabled: boolean;
    revision: number;
    hasCredential: boolean;
    testedRevision: number | null;
}
export interface PlanInput {
    id?: string | undefined;
    revision?: number | undefined;
    code: string;
    name: string;
    connectionId: string;
    modelId: string;
    enabled: boolean;
    isDefault: boolean;
    systemPrompt?: string | null | undefined;
    parameters?: GenerationParameters | undefined;
}
export interface Plan extends Omit<PlanInput, "id" | "revision" | "systemPrompt" | "parameters"> {
    id: string;
    revision: number;
    systemPrompt: string | null;
    parameters: GenerationParameters;
}
export interface PlanSummary {
    code: string;
    name: string;
    modelId: string;
    providerCode: string;
    isDefault: boolean;
}
export interface TextMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface CallInput {
    code?: string | undefined;
    messages: TextMessage[];
    systemPrompt?: string | undefined;
    options?: GenerationParameters | undefined;
    signal?: AbortSignal | undefined;
}
export interface Usage {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    reasoningTokens: number | null;
}
export type CompletionStatus = "completed" | "incomplete";
export interface GenerationResult {
    text: string;
    reasoning: string;
    code: string;
    providerCode: string;
    modelId: string;
    status: CompletionStatus;
    finishReason: string;
    durationMs: number;
    requestId: string | null;
    usage: Usage | null;
}
export type ErrorCode = "INVALID_CONFIG" | "INVALID_INPUT" | "UNSUPPORTED_PROVIDER" | "UNSUPPORTED_PROTOCOL" | "UNSUPPORTED_PARAMETER" | "MODEL_CAPABILITIES_REQUIRED" | "FORBIDDEN" | "RATE_LIMITED" | "NOT_FOUND" | "DISABLED" | "NO_DEFAULT_PLAN" | "DEFAULT_REQUIRES_ACTION" | "CONFLICT" | "CONNECTION_IN_USE" | "CREDENTIAL_SECURITY_REQUIRED" | "CREDENTIAL_FAILURE" | "KEY_DOMAIN_CONFIRMATION_REQUIRED" | "UNSAFE_URL" | "AUTHENTICATION" | "QUOTA" | "MODEL_PERMISSION" | "PARAMETER" | "NETWORK" | "TIMEOUT" | "CANCELLED" | "OUTPUT_LIMIT" | "STREAM_INTERRUPTED" | "PROVIDER_ERROR" | "MODEL_REFRESH_UNSUPPORTED";
export interface SafeError {
    code: ErrorCode;
    message: string;
}
export type StreamEvent = {
    type: "text-delta" | "reasoning-delta";
    delta: string;
} | {
    type: "finish";
    result: GenerationResult;
} | {
    type: "error";
    error: SafeError;
};
export interface TestDraft {
    connection: ConnectionInput;
    modelId: string;
    parameters?: GenerationParameters;
}
export interface TestResult {
    result: GenerationResult | null;
    error: SafeError | null;
    status: "completed" | "incomplete" | "failed";
    durationMs: number;
}
/** Safe caps can be conservative verified ceilings rather than a vendor's advertised maximum. */
export interface ParameterRange {
    min: number;
    max: number;
    exclusiveMax?: boolean;
    decimals?: number;
}
export interface ModelCapabilities {
    maxOutputTokens: number;
    temperature: ParameterRange | null;
    topP: ParameterRange | null;
    thinking: boolean;
    budget: "final-and-reasoning" | "final";
}
export interface ModelPreset extends ModelCapabilities {
    providerCode: string;
    modelId: string;
    name: string;
    protocol: Protocol;
    source: string;
    checkedAt: string;
    recommended: boolean;
}
export interface EndpointTemplate {
    name: string;
    baseURL: string;
    protocol: Protocol;
    purpose: "ordinary" | "subscription";
    source: string;
}
export interface ProviderAdapterInfo {
    code: string;
    protocols: readonly Protocol[];
    recommendedProtocol: Protocol;
    endpoints: readonly EndpointTemplate[];
    modelsPath: string | null;
}
