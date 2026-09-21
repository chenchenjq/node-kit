import { describe, expect, it } from "vitest";

import { normalizeMainlandPhone, type MessageId, type TenantId } from "../../../src/core/index.js";
import type { ProtectionContext } from "../../../src/ports/index.js";
import {
  AesGcmMessagePayloadProtector,
  AesGcmPhoneNumberProtector,
  HmacHasher,
} from "../../../src/security/index.js";

const aesKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const hmacKey = Buffer.from("abcdef0123456789abcdef0123456789", "utf8");
const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;
const messageA = "a8d6524c-3fef-43b6-a059-0c3cc8ff41a9" as MessageId;
const messageB = "c3a8284a-d388-4445-b2a1-81179fe28d54" as MessageId;

function keyring(key = aesKey) {
  return {
    activeKey: async () => ({ id: "k1", bytes: key }),
    keyById: async (id: string) => (id === "k1" ? key : undefined),
  };
}

function withTamperedGcmTag(ciphertext: string): string {
  const envelope = JSON.parse(Buffer.from(ciphertext, "base64url").toString("utf8")) as {
    v: 1;
    iv: string;
    tag: string;
    data: string;
  };
  const tag = Buffer.from(envelope.tag, "base64url");
  tag[0] = (tag[0] ?? 0) ^ 1;

  return Buffer.from(JSON.stringify({ ...envelope, tag: tag.toString("base64url") }), "utf8").toString("base64url");
}

const payloadContext: ProtectionContext = {
  envelopeVersion: 1,
  purpose: "render-params",
  tenantId: tenantA,
  recordId: messageA,
  fieldName: "render_params_ciphertext",
};

const phoneContext: ProtectionContext = {
  envelopeVersion: 1,
  purpose: "phone",
  tenantId: tenantA,
  recordId: messageA,
  fieldName: "phone_ciphertext",
};

describe("HmacHasher", () => {
  it("verifies only a value matching its HMAC", async () => {
    const hasher = new HmacHasher(hmacKey);
    const hash = await hasher.hash("123456");

    expect(hash).not.toContain("123456");
    await expect(hasher.verify("123456", hash)).resolves.toBe(true);
    await expect(hasher.verify("654321", hash)).resolves.toBe(false);
    await expect(hasher.verify("123456", "not-a-valid-hash")).resolves.toBe(false);
  });

  it("rejects an invalid HMAC key without retaining key material in the error", () => {
    expect(() => new HmacHasher(Buffer.alloc(31))).toThrowError(/HMAC key/);
  });
});

describe("AES-GCM protectors", () => {
  it("encrypts render parameters with the active key and bound context", async () => {
    const protector = new AesGcmMessagePayloadProtector(keyring());
    const sealed = await protector.seal({ order: "A-100" }, payloadContext);

    expect(sealed.keyId).toBe("k1");
    expect(sealed.ciphertext).not.toContain("A-100");
    await expect(protector.open(sealed, payloadContext)).resolves.toEqual({ order: "A-100" });
    await expect(protector.open(sealed, { ...payloadContext, recordId: messageB })).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      message: "protected value could not be opened",
    });
  });

  it("rejects altered ciphertext, unknown keys, and tenant or field swaps", async () => {
    const protector = new AesGcmMessagePayloadProtector(keyring());
    const sealed = await protector.seal({ order: "A-100" }, payloadContext);
    const altered = `${sealed.ciphertext.slice(0, -1)}${sealed.ciphertext.endsWith("A") ? "B" : "A"}`;

    for (const input of [
      { ciphertext: altered, keyId: sealed.keyId },
      { ciphertext: sealed.ciphertext, keyId: "missing-key" },
    ]) {
      await expect(protector.open(input, payloadContext)).rejects.toMatchObject({
        code: "STORAGE_FAILURE",
        message: "protected value could not be opened",
      });
    }

    await expect(protector.open(sealed, { ...payloadContext, tenantId: tenantB })).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
    });
    await expect(protector.open(sealed, {
      ...payloadContext,
      purpose: "phone",
      fieldName: "phone_ciphertext",
    })).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  });

  it("rejects a canonical envelope with a modified GCM authentication tag", async () => {
    const protector = new AesGcmMessagePayloadProtector(keyring());
    const sealed = await protector.seal({ order: "A-100" }, payloadContext);
    const tamperedCiphertext = withTamperedGcmTag(sealed.ciphertext);

    await expect(protector.open({ ...sealed, ciphertext: tamperedCiphertext }, payloadContext)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      message: "protected value could not be opened",
    });
  });

  it("rejects ciphertext opened with different material for the same key id", async () => {
    const protector = new AesGcmMessagePayloadProtector(keyring());
    const sealed = await protector.seal({ order: "A-100" }, payloadContext);
    const wrongKeyProtector = new AesGcmMessagePayloadProtector(keyring(Buffer.alloc(32, 1)));

    await expect(wrongKeyProtector.open(sealed, payloadContext)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      message: "protected value could not be opened",
    });
  });

  it("rejects invalid AES key material before encrypting", async () => {
    const protector = new AesGcmMessagePayloadProtector(keyring(Buffer.alloc(31)));

    await expect(protector.seal({ order: "A-100" }, payloadContext)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "invalid encryption key configuration",
    });
  });

  it("protects phone values with a distinct HMAC lookup hash and redacted metadata", async () => {
    const phone = normalizeMainlandPhone("13800138000");
    const hasher = new HmacHasher(hmacKey);
    const protector = new AesGcmPhoneNumberProtector(keyring(), hasher);
    const protectedPhone = await protector.protect(phone, phoneContext);

    expect(protectedPhone.keyId).toBe("k1");
    expect(protectedPhone.ciphertext).not.toContain(phone);
    expect(protectedPhone.lookupHash).not.toContain(phone);
    expect(protectedPhone.masked).toBe("138****8000");
    expect(protectedPhone.last4).toBe("8000");
    await expect(protector.unprotect(protectedPhone, phoneContext)).resolves.toBe(phone);
    await expect(protector.unprotect(protectedPhone, { ...phoneContext, recordId: messageB })).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
    });
  });
});
