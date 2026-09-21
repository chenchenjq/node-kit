import type { CredentialProtector } from "../types.js";
/** Supply a server environment value containing exactly 32 random bytes encoded as base64. */
export declare function createAesGcmCredentialProtector(base64Key: string): CredentialProtector;
