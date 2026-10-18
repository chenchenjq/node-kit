import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SmsKitError } from "../core/errors.js";
import { maskMainlandPhone, normalizeMainlandPhone, normalizeMainlandNationalPhone } from "../core/phone.js";
import { HmacHasher } from "./hmac-hasher.js";
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const STORAGE_FAILURE_MESSAGE = "protected value could not be opened";
const INVALID_KEY_MESSAGE = "invalid encryption key configuration";
function configurationError() {
    return new SmsKitError("CONFIG_INVALID", INVALID_KEY_MESSAGE);
}
function storageFailure() {
    return new SmsKitError("STORAGE_FAILURE", STORAGE_FAILURE_MESSAGE);
}
function assertKey(key) {
    if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
        throw configurationError();
    }
}
function assertKeyId(keyId) {
    if (typeof keyId !== "string" || keyId.length === 0 || keyId.length > 256) {
        throw configurationError();
    }
}
function encodeAad(keyId, context) {
    return Buffer.from(JSON.stringify([
        context.envelopeVersion,
        keyId,
        context.purpose,
        context.tenantId,
        context.recordId,
        context.fieldName,
    ]), "utf8");
}
function encodeEnvelope(envelope) {
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}
function decodeBase64url(value, expectedLength) {
    if (typeof value !== "string" || !BASE64URL.test(value)) {
        throw storageFailure();
    }
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0 ||
        decoded.toString("base64url") !== value ||
        (expectedLength !== undefined && decoded.length !== expectedLength)) {
        throw storageFailure();
    }
    return decoded;
}
function decodeEnvelope(ciphertext) {
    const serialized = decodeBase64url(ciphertext);
    let parsed;
    try {
        parsed = JSON.parse(serialized.toString("utf8"));
    }
    catch {
        throw storageFailure();
    }
    if (typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 4 ||
        !("v" in parsed) ||
        !("iv" in parsed) ||
        !("tag" in parsed) ||
        !("data" in parsed) ||
        parsed.v !== 1) {
        throw storageFailure();
    }
    const iv = decodeBase64url(parsed.iv, GCM_IV_BYTES);
    const tag = decodeBase64url(parsed.tag, GCM_TAG_BYTES);
    const data = decodeBase64url(parsed.data);
    return {
        v: 1,
        iv: iv.toString("base64url"),
        tag: tag.toString("base64url"),
        data: data.toString("base64url"),
    };
}
function sealBytes(key, keyId, plaintext, context) {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(encodeAad(keyId, context));
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return encodeEnvelope({
        v: 1,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        data: data.toString("base64url"),
    });
}
function openBytes(key, keyId, ciphertext, context) {
    const envelope = decodeEnvelope(ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(encodeAad(keyId, context));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64url")),
        decipher.final(),
    ]);
}
async function activeKey(keyring) {
    try {
        const key = await keyring.activeKey();
        assertKeyId(key.id);
        assertKey(key.bytes);
        return key;
    }
    catch {
        throw configurationError();
    }
}
async function keyForOpen(keyring, keyId) {
    try {
        assertKeyId(keyId);
        const key = await keyring.keyById(keyId);
        if (key === undefined || !Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
            throw storageFailure();
        }
        return key;
    }
    catch {
        throw storageFailure();
    }
}
function isStringRecord(value) {
    return (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((entry) => typeof entry === "string"));
}
function serializePayload(value) {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new Error("not serializable");
        }
        return Buffer.from(serialized, "utf8");
    }
    catch {
        throw new SmsKitError("CONFIG_INVALID", "invalid protected payload");
    }
}
function deserializePayload(value) {
    try {
        const parsed = JSON.parse(value.toString("utf8"));
        if (!isStringRecord(parsed)) {
            throw new Error("not a string record");
        }
        return Object.freeze(Object.fromEntries(Object.entries(parsed)));
    }
    catch {
        throw storageFailure();
    }
}
export class AesGcmMessagePayloadProtector {
    keyring;
    constructor(keyring) {
        this.keyring = keyring;
    }
    async seal(value, context) {
        const key = await activeKey(this.keyring);
        return {
            ciphertext: sealBytes(key.bytes, key.id, serializePayload(value), context),
            keyId: key.id,
        };
    }
    async open(input, context) {
        try {
            return deserializePayload(openBytes(await keyForOpen(this.keyring, input.keyId), input.keyId, input.ciphertext, context));
        }
        catch {
            throw storageFailure();
        }
    }
}
export class AesGcmPhoneNumberProtector {
    keyring;
    hasher;
    options;
    constructor(keyring, hasher, options = {}) {
        this.keyring = keyring;
        this.hasher = hasher;
        this.options = options;
    }
    async lookupHash(phone) {
        return this.hasher.hash(phone);
    }
    async protect(phone, context) {
        const key = await activeKey(this.keyring);
        return {
            ciphertext: sealBytes(key.bytes, key.id, Buffer.from(this.options.storageFormat === "national" ? normalizeMainlandNationalPhone(phone) : phone, "utf8"), context),
            keyId: key.id,
            lookupHash: await this.lookupHash(phone),
            masked: maskMainlandPhone(phone),
            last4: phone.slice(-4),
        };
    }
    async unprotect(input, context) {
        try {
            const plaintext = openBytes(await keyForOpen(this.keyring, input.keyId), input.keyId, input.ciphertext, context);
            return normalizeMainlandPhone(plaintext.toString("utf8"));
        }
        catch {
            throw storageFailure();
        }
    }
}
