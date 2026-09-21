import { Readable } from "node:stream";
import { fileTypeFromBuffer } from "file-type";
import { validatedExtension } from "../rules/index.js";
import { OssKitError } from "./errors.js";
import { MIME_BY_EXTENSION } from "./validation.js";
export async function collectBody(body, limit, timeout) {
    if (Buffer.isBuffer(body)) {
        if (body.length > limit)
            throw new OssKitError("FILE_TOO_LARGE");
        return Buffer.from(body);
    }
    if (!(body instanceof Readable))
        throw new OssKitError("INVALID_FILE");
    const chunks = [];
    let bytes = 0;
    let timer;
    const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            const error = new OssKitError("TIMEOUT");
            chunks.length = 0;
            body.destroy(error);
            reject(error);
        }, timeout);
    });
    try {
        return await Promise.race([expired, (async () => {
                for await (const chunk of body) {
                    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array) && typeof chunk !== "string")
                        throw new OssKitError("INVALID_FILE");
                    const data = Buffer.from(chunk);
                    bytes += data.length;
                    if (bytes > limit)
                        throw new OssKitError("FILE_TOO_LARGE");
                    chunks.push(data);
                }
                return Buffer.concat(chunks, bytes);
            })()]);
    }
    catch (e) {
        body.destroy();
        throw e instanceof OssKitError ? e : new OssKitError("INVALID_FILE");
    }
    finally {
        clearTimeout(timer);
    }
}
export async function validateContent(data, originalName, suppliedMime, strategy) {
    const extension = validatedExtension(originalName, strategy.allowedExtensions);
    const expected = MIME_BY_EXTENSION[extension];
    if (!expected || typeof suppliedMime !== "string" || suppliedMime.toLowerCase() !== expected || !strategy.allowedMimeTypes.includes(expected) || data.length === 0)
        throw new OssKitError("TYPE_MISMATCH");
    try {
        if (expected === "text/plain" || expected === "application/json") {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
            if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /<\s*(?:!doctype\s+html|html|head|body|script|svg|iframe|object|embed|link|style|meta)\b/i.test(text))
                throw new Error();
            if (expected === "application/json")
                JSON.parse(text);
        }
        else {
            const detected = await fileTypeFromBuffer(data);
            if (detected?.mime !== expected)
                throw new Error();
        }
    }
    catch {
        throw new OssKitError("TYPE_MISMATCH");
    }
    return expected;
}
