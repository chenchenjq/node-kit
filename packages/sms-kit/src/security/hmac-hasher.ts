import { createHmac, timingSafeEqual } from "node:crypto";

import { SmsKitError } from "../core/errors.js";
import type { OtpHasher } from "../ports/security.js";

const HMAC_KEY_BYTES = 32;
const HMAC_HASH_LENGTH = 32;
const HMAC_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** HMAC-SHA-256 hasher for values that must be verified or looked up without persistence. */
export class HmacHasher implements OtpHasher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length !== HMAC_KEY_BYTES) {
      throw new SmsKitError("CONFIG_INVALID", "invalid HMAC key configuration");
    }

    this.key = Buffer.from(key);
  }

  async hash(value: string): Promise<string> {
    return createHmac("sha256", this.key).update(value, "utf8").digest("base64url");
  }

  async verify(value: string, hash: string): Promise<boolean> {
    if (!HMAC_HASH_PATTERN.test(hash)) {
      return false;
    }

    const supplied = Buffer.from(hash, "base64url");
    if (supplied.length !== HMAC_HASH_LENGTH || supplied.toString("base64url") !== hash) {
      return false;
    }

    const expected = Buffer.from(await this.hash(value), "base64url");
    return timingSafeEqual(expected, supplied);
  }
}
