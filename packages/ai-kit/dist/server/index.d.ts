import type { AiKit, AiKitOptions } from "./contracts.js";
export declare function createAiKit<C>(options: AiKitOptions<C>): AiKit<C>;
export { AiKitError } from "./errors.js";
export { createAesGcmSecretProtector, createEnvironmentSecretProtector, } from "./secrets.js";
export type { AiKit, AiKitOptions, AiStore, StoreView, ConnectionRecord, SecretProtector, AuthorizationRequest, HostLimits, LogMetadata, } from "./contracts.js";
