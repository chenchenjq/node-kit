import { type MainlandPhone } from "../core/phone.js";
import type { MessagePayloadProtector, PhoneLookupHasher, PhoneNumberProtector, ProtectionContext } from "../ports/security.js";
import { HmacHasher } from "./hmac-hasher.js";
export interface AesKeyring {
    activeKey(): Promise<Readonly<{
        id: string;
        bytes: Buffer;
    }>>;
    keyById(id: string): Promise<Buffer | undefined>;
}
export declare class AesGcmMessagePayloadProtector implements MessagePayloadProtector {
    private readonly keyring;
    constructor(keyring: AesKeyring);
    seal(value: Readonly<Record<string, string>>, context: ProtectionContext): Promise<{
        ciphertext: string;
        keyId: string;
    }>;
    open(input: {
        ciphertext: string;
        keyId: string;
    }, context: ProtectionContext): Promise<Readonly<Record<string, string>>>;
}
export declare class AesGcmPhoneNumberProtector implements PhoneNumberProtector, PhoneLookupHasher {
    private readonly keyring;
    private readonly hasher;
    private readonly options;
    constructor(keyring: AesKeyring, hasher: HmacHasher, options?: {
        storageFormat?: "e164" | "national";
    });
    lookupHash(phone: MainlandPhone): Promise<string>;
    protect(phone: MainlandPhone, context: ProtectionContext): Promise<{
        ciphertext: string;
        keyId: string;
        lookupHash: string;
        masked: string;
        last4: string;
    }>;
    unprotect(input: {
        ciphertext: string;
        keyId: string;
    }, context: ProtectionContext): Promise<MainlandPhone>;
}
