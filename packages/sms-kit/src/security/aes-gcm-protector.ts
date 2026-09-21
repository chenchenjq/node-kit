import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { SmsKitError } from "../core/errors.js";
import { maskMainlandPhone, normalizeMainlandPhone, type MainlandPhone } from "../core/phone.js";
import type {
  MessagePayloadProtector,
  PhoneLookupHasher,
  PhoneNumberProtector,
  ProtectionContext,
} from "../ports/security.js";
import { HmacHasher } from "./hmac-hasher.js";

const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const STORAGE_FAILURE_MESSAGE = "protected value could not be opened";
const INVALID_KEY_MESSAGE = "invalid encryption key configuration";

type CipherEnvelope = Readonly<{ v: 1; iv: string; tag: string; data: string }>;

export interface AesKeyring {
  activeKey(): Promise<Readonly<{ id: string; bytes: Buffer }>>;
  keyById(id: string): Promise<Buffer | undefined>;
}

function configurationError(): SmsKitError {
  return new SmsKitError("CONFIG_INVALID", INVALID_KEY_MESSAGE);
}

function storageFailure(): SmsKitError {
  return new SmsKitError("STORAGE_FAILURE", STORAGE_FAILURE_MESSAGE);
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    throw configurationError();
  }
}

function assertKeyId(keyId: string): void {
  if (typeof keyId !== "string" || keyId.length === 0 || keyId.length > 256) {
    throw configurationError();
  }
}

function encodeAad(keyId: string, context: ProtectionContext): Buffer {
  return Buffer.from(JSON.stringify([
    context.envelopeVersion,
    keyId,
    context.purpose,
    context.tenantId,
    context.recordId,
    context.fieldName,
  ]), "utf8");
}

function encodeEnvelope(envelope: CipherEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeBase64url(value: unknown, expectedLength?: number): Buffer {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    throw storageFailure();
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length === 0 ||
    decoded.toString("base64url") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    throw storageFailure();
  }

  return decoded;
}

function decodeEnvelope(ciphertext: string): CipherEnvelope {
  const serialized = decodeBase64url(ciphertext);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized.toString("utf8"));
  } catch {
    throw storageFailure();
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 4 ||
    !("v" in parsed) ||
    !("iv" in parsed) ||
    !("tag" in parsed) ||
    !("data" in parsed) ||
    parsed.v !== 1
  ) {
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

function sealBytes(key: Buffer, keyId: string, plaintext: Buffer, context: ProtectionContext): string {
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

function openBytes(key: Buffer, keyId: string, ciphertext: string, context: ProtectionContext): Buffer {
  const envelope = decodeEnvelope(ciphertext);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(encodeAad(keyId, context));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64url")),
    decipher.final(),
  ]);
}

async function activeKey(keyring: AesKeyring): Promise<Readonly<{ id: string; bytes: Buffer }>> {
  try {
    const key = await keyring.activeKey();
    assertKeyId(key.id);
    assertKey(key.bytes);
    return key;
  } catch {
    throw configurationError();
  }
}

async function keyForOpen(keyring: AesKeyring, keyId: string): Promise<Buffer> {
  try {
    assertKeyId(keyId);
    const key = await keyring.keyById(keyId);
    if (key === undefined || !Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
      throw storageFailure();
    }
    return key;
  } catch {
    throw storageFailure();
  }
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function serializePayload(value: Readonly<Record<string, string>>): Buffer {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("not serializable");
    }
    return Buffer.from(serialized, "utf8");
  } catch {
    throw new SmsKitError("CONFIG_INVALID", "invalid protected payload");
  }
}

function deserializePayload(value: Buffer): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(value.toString("utf8"));
    if (!isStringRecord(parsed)) {
      throw new Error("not a string record");
    }
    return Object.freeze(Object.fromEntries(Object.entries(parsed)));
  } catch {
    throw storageFailure();
  }
}

export class AesGcmMessagePayloadProtector implements MessagePayloadProtector {
  constructor(private readonly keyring: AesKeyring) {}

  async seal(
    value: Readonly<Record<string, string>>,
    context: ProtectionContext,
  ): Promise<{ ciphertext: string; keyId: string }> {
    const key = await activeKey(this.keyring);
    return {
      ciphertext: sealBytes(key.bytes, key.id, serializePayload(value), context),
      keyId: key.id,
    };
  }

  async open(
    input: { ciphertext: string; keyId: string },
    context: ProtectionContext,
  ): Promise<Readonly<Record<string, string>>> {
    try {
      return deserializePayload(openBytes(await keyForOpen(this.keyring, input.keyId), input.keyId, input.ciphertext, context));
    } catch {
      throw storageFailure();
    }
  }
}

export class AesGcmPhoneNumberProtector implements PhoneNumberProtector, PhoneLookupHasher {
  constructor(
    private readonly keyring: AesKeyring,
    private readonly hasher: HmacHasher,
  ) {}

  async lookupHash(phone: MainlandPhone): Promise<string> {
    return this.hasher.hash(phone);
  }

  async protect(
    phone: MainlandPhone,
    context: ProtectionContext,
  ): Promise<{ ciphertext: string; keyId: string; lookupHash: string; masked: string; last4: string }> {
    const key = await activeKey(this.keyring);
    return {
      ciphertext: sealBytes(key.bytes, key.id, Buffer.from(phone, "utf8"), context),
      keyId: key.id,
      lookupHash: await this.lookupHash(phone),
      masked: maskMainlandPhone(phone),
      last4: phone.slice(-4),
    };
  }

  async unprotect(
    input: { ciphertext: string; keyId: string },
    context: ProtectionContext,
  ): Promise<MainlandPhone> {
    try {
      const plaintext = openBytes(await keyForOpen(this.keyring, input.keyId), input.keyId, input.ciphertext, context);
      return normalizeMainlandPhone(plaintext.toString("utf8"));
    } catch {
      throw storageFailure();
    }
  }
}
