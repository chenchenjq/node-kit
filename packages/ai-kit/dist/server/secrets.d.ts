import type { SecretProtector } from "./contracts.js";
export declare function createAesGcmSecretProtector(base64Key: string): SecretProtector;
/** References only: no plaintext is persisted; the host explicitly names permitted environment variables. */
export declare function createEnvironmentSecretProtector(allowedNames: readonly string[], read?: (name: string) => string | undefined): SecretProtector;
