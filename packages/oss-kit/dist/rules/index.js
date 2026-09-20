import { OssKitError } from "./errors.js";
export { OssKitError, errorInfo } from "./errors.js";
export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_SIZE_BYTES = 32 * 1024 * 1024;
export function validatePrefix(value) {
    if (typeof value !== "string" || !value || value.length > 200 || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value))
        throw new OssKitError("INVALID_PATH");
    return value;
}
export function validateObjectKey(value, applicationPrefix) {
    if (typeof value !== "string" || new TextEncoder().encode(value).length > 1024 || !value.startsWith(`${applicationPrefix}/`) || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(value) || value.split("/").some(p => p === "." || p === ".." || !p || p.length > 200))
        throw new OssKitError("INVALID_PATH");
    return value;
}
export function validatedExtension(originalName, allowed) {
    if (typeof originalName !== "string" || originalName.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(originalName))
        throw new OssKitError("INVALID_FILE");
    const match = /^(.+)\.([a-zA-Z0-9]{1,10})$/.exec(originalName);
    const extension = match?.[2]?.toLowerCase();
    if (!extension || !allowed.includes(extension))
        throw new OssKitError("INVALID_FILE");
    return extension;
}
export function validateTimeZone(value) {
    try {
        new Intl.DateTimeFormat("en", { timeZone: value }).format();
        return value;
    }
    catch {
        throw new OssKitError("INVALID_CONFIG");
    }
}
/** Also used by uploads. randomId is supplied by the server for real uploads; never accept it from HTTP input. */
export function previewObjectKey(input) {
    const app = validatePrefix(input.applicationPrefix), prefix = validatePrefix(input.strategy.prefix);
    const zone = validateTimeZone(input.timeZone ?? DEFAULT_TIME_ZONE);
    const extension = validatedExtension(input.originalName, input.strategy.allowedExtensions);
    const date = input.now ?? new Date();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
        throw new OssKitError("INVALID_CONFIG");
    const random = input.randomId ?? globalThis.crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(random))
        throw new OssKitError("INVALID_PATH");
    const parts = new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type) => parts.find(p => p.type === type).value;
    let directories;
    switch (input.strategy.dateDirectory) {
        case "fixed":
            directories = [];
            break;
        case "year-month":
            directories = [part("year"), part("month")];
            break;
        case "year-month-day":
            directories = [part("year"), part("month"), part("day")];
            break;
        default: throw new OssKitError("INVALID_STRATEGY");
    }
    let filename;
    switch (input.strategy.naming) {
        case "uuid":
            filename = random;
            break;
        case "timestamp-random":
            filename = `${date.getTime()}-${random}`;
            break;
        case "original-random": {
            const stem = input.originalName.slice(0, -(extension.length + 1)).normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
            filename = `${stem}-${random}`;
            break;
        }
        default: throw new OssKitError("INVALID_STRATEGY");
    }
    return validateObjectKey([app, prefix, ...directories, `${filename}.${extension}`].join("/"), app);
}
