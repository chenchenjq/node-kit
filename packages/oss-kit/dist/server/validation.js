import { DEFAULT_MAX_SIZE_BYTES, validatePrefix } from "../rules/index.js";
import { OssKitError } from "./errors.js";
export const MIME_BY_EXTENSION = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain", json: "application/json" };
function text(value, max, code, allowEmpty = false) {
    if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
        throw new OssKitError(code);
    return value.trim();
}
function boolean(value, fallback, code) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "boolean")
        throw new OssKitError(code);
    return value;
}
export function publicDomain(value) {
    if (value === undefined || value === null || value === "")
        return null;
    try {
        if (typeof value !== "string")
            throw new Error();
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(url.hostname) || /(?:^|\.)(localhost|local|internal|test)$/.test(url.hostname) || url.hostname.includes("-internal.aliyuncs.com"))
            throw new Error();
        return url.origin;
    }
    catch {
        throw new OssKitError("INVALID_CONFIG");
    }
}
export function validateStorage(input) {
    if (!input || typeof input !== "object")
        throw new OssKitError("INVALID_CONFIG");
    const name = text(input.name, 100, "INVALID_CONFIG"), region = text(input.region, 60, "INVALID_CONFIG"), bucket = text(input.bucket, 63, "INVALID_CONFIG");
    if (!/^oss-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region) || region.endsWith("-internal") || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
        throw new OssKitError("INVALID_CONFIG");
    const external = `https://${region}.aliyuncs.com`, internal = `https://${region}-internal.aliyuncs.com`;
    const endpoint = input.endpoint || external;
    if (endpoint !== external && endpoint !== internal)
        throw new OssKitError("INVALID_CONFIG");
    const access = input.access ?? "private";
    if (access !== "public" && access !== "private")
        throw new OssKitError("INVALID_CONFIG");
    return { name, region, bucket, endpoint, access, publicDomain: publicDomain(input.publicDomain), enabled: boolean(input.enabled, true, "INVALID_CONFIG") };
}
export function validateCredentials(value) {
    if (!value || typeof value.accessKeyId !== "string" || !value.accessKeyId.trim() || value.accessKeyId.length > 256 || typeof value.accessKeySecret !== "string" || !value.accessKeySecret.trim() || value.accessKeySecret.length > 512 || /[\u0000-\u001f\u007f]/.test(value.accessKeyId + value.accessKeySecret) || (value.stsToken !== undefined && (typeof value.stsToken !== "string" || !value.stsToken || value.stsToken.length > 8192)))
        throw new OssKitError("CREDENTIAL_FAILURE");
    return { accessKeyId: value.accessKeyId.trim(), accessKeySecret: value.accessKeySecret.trim(), ...(value.stsToken ? { stsToken: value.stsToken } : {}) };
}
export function validateStrategy(input, maxBytes) {
    if (!input || typeof input !== "object")
        throw new OssKitError("INVALID_STRATEGY");
    const code = text(input.code, 64, "INVALID_STRATEGY"), name = text(input.name, 100, "INVALID_STRATEGY"), description = text(input.description, 1000, "INVALID_STRATEGY", true);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(code))
        throw new OssKitError("INVALID_STRATEGY");
    const prefix = validatePrefix(input.prefix), dateDirectory = input.dateDirectory ?? "fixed", naming = input.naming ?? "uuid";
    if (!["fixed", "year-month", "year-month-day"].includes(dateDirectory) || !["uuid", "timestamp-random", "original-random"].includes(naming))
        throw new OssKitError("INVALID_STRATEGY");
    if (!Array.isArray(input.allowedExtensions) || !input.allowedExtensions.length || !Array.isArray(input.allowedMimeTypes) || !input.allowedMimeTypes.length || input.allowedExtensions.length > 20 || input.allowedMimeTypes.length > 20)
        throw new OssKitError("INVALID_STRATEGY");
    const extensions = input.allowedExtensions.map(x => text(x, 10, "INVALID_STRATEGY").toLowerCase());
    const mimes = input.allowedMimeTypes.map(x => text(x, 80, "INVALID_STRATEGY").toLowerCase());
    if (extensions.some(x => !Object.hasOwn(MIME_BY_EXTENSION, x) || !mimes.includes(MIME_BY_EXTENSION[x])) || mimes.some(x => !extensions.some(ext => MIME_BY_EXTENSION[ext] === x)))
        throw new OssKitError("INVALID_STRATEGY");
    const maxSizeBytes = input.maxSizeBytes ?? Math.min(DEFAULT_MAX_SIZE_BYTES, maxBytes);
    if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes < 1 || maxSizeBytes > maxBytes)
        throw new OssKitError("INVALID_STRATEGY");
    const storageConfigId = input.storageConfigId ?? null;
    if (storageConfigId !== null && (typeof storageConfigId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(storageConfigId)))
        throw new OssKitError("INVALID_STRATEGY");
    return { code, name, description, storageConfigId, prefix, dateDirectory, naming, allowedExtensions: [...new Set(extensions)], allowedMimeTypes: [...new Set(mimes)], maxSizeBytes, enabled: boolean(input.enabled, true, "INVALID_STRATEGY"), used: false };
}
