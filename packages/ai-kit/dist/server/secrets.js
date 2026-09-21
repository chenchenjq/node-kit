import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AiKitError } from "./errors.js";
export function createAesGcmSecretProtector(base64Key) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32 || key.toString("base64") !== base64Key)
        throw new AiKitError("CREDENTIAL_SECURITY_REQUIRED");
    return {
        async seal(secret, binding) {
            if (!secret || secret.length > 4096)
                throw new AiKitError("INVALID_INPUT");
            const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
            cipher.setAAD(Buffer.from(`ai-kit:v1:${binding}`));
            const data = Buffer.concat([
                cipher.update(secret, "utf8"),
                cipher.final(),
            ]);
            return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
        },
        async open(envelope, binding) {
            try {
                const [version, iv, tag, data, ...extra] = envelope.split(".");
                if (version !== "v1" || !iv || !tag || !data || extra.length)
                    throw new Error();
                if ([iv, tag, data].some((x) => Buffer.from(x, "base64url").toString("base64url") !== x))
                    throw new Error();
                if (Buffer.from(iv, "base64url").length !== 12 ||
                    Buffer.from(tag, "base64url").length !== 16)
                    throw new Error();
                const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
                d.setAAD(Buffer.from(`ai-kit:v1:${binding}`));
                d.setAuthTag(Buffer.from(tag, "base64url"));
                const secret = Buffer.concat([
                    d.update(Buffer.from(data, "base64url")),
                    d.final(),
                ]).toString("utf8");
                if (!secret)
                    throw new Error();
                return secret;
            }
            catch {
                throw new AiKitError("CREDENTIAL_FAILURE");
            }
        },
    };
}
/** References only: no plaintext is persisted; the host explicitly names permitted environment variables. */
export function createEnvironmentSecretProtector(allowedNames, read = (name) => process.env[name]) {
    function variable(ref) {
        const name = ref.startsWith("env:") ? ref.slice(4) : "";
        if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name) || !allowedNames.includes(name))
            throw new AiKitError("CREDENTIAL_FAILURE");
        return name;
    }
    return {
        async seal(ref) {
            try {
                variable(ref);
                return ref;
            }
            catch {
                throw new AiKitError("CREDENTIAL_SECURITY_REQUIRED");
            }
        },
        async open(ref) {
            const value = read(variable(ref));
            if (!value || value.length > 4096)
                throw new AiKitError("CREDENTIAL_FAILURE");
            return value;
        },
    };
}
