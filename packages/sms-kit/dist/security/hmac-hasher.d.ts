import type { OtpHasher } from "../ports/security.js";
/** HMAC-SHA-256 hasher for values that must be verified or looked up without persistence. */
export declare class HmacHasher implements OtpHasher {
    private readonly key;
    constructor(key: Buffer);
    hash(value: string): Promise<string>;
    verify(value: string, hash: string): Promise<boolean>;
}
