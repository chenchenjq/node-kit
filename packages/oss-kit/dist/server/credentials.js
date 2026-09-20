import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { OssKitError } from "./errors.js";
import { validateCredentials } from "./validation.js";
/** Supply a server environment value containing exactly 32 random bytes encoded as base64. */
export function createAesGcmCredentialProtector(base64Key) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32 || key.toString("base64") !== base64Key)
        throw new OssKitError("CREDENTIAL_SECURITY_REQUIRED");
    return {
        async seal(credentials) {
            try {
                const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
                cipher.setAAD(Buffer.from("oss-kit:credentials:v1"));
                const encrypted = Buffer.concat([cipher.update(JSON.stringify(validateCredentials(credentials)), "utf8"), cipher.final()]);
                return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
            }
            catch {
                throw new OssKitError("CREDENTIAL_FAILURE");
            }
        },
        async open(envelope) {
            try {
                const parts = envelope.split(".");
                const [version, iv, tag, data] = parts;
                if (parts.length !== 4 || version !== "v1" || !iv || !tag || !data)
                    throw new Error();
                if ([iv, tag, data].some(part => Buffer.from(part, "base64url").toString("base64url") !== part))
                    throw new Error();
                if (Buffer.from(iv, "base64url").length !== 12 || Buffer.from(tag, "base64url").length !== 16)
                    throw new Error();
                const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"), { authTagLength: 16 });
                decipher.setAAD(Buffer.from("oss-kit:credentials:v1"));
                decipher.setAuthTag(Buffer.from(tag, "base64url"));
                const bytes = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
                return validateCredentials(JSON.parse(bytes.toString("utf8")));
            }
            catch {
                throw new OssKitError("CREDENTIAL_FAILURE");
            }
        },
    };
}
