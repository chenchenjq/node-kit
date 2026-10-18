import { createHash } from "node:crypto";
function canonicalize(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new TypeError("checksum input must contain finite numbers");
        return value;
    }
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (typeof value === "object") {
        const source = value;
        return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonicalize(source[key])]));
    }
    throw new TypeError("checksum input must be JSON data");
}
/** A deterministic SHA-256 checksum over a recursively key-sorted JSON value. */
export function canonicalChecksum(value) {
    return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("base64url");
}
