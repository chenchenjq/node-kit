import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DEFAULT_TIME_ZONE, HARD_MAX_SIZE_BYTES, previewObjectKey, validateObjectKey, validatePrefix, validatedExtension, validateTimeZone } from "../rules/index.js";
import { createAliyunTransport } from "./aliyun.js";
import { collectBody, validateContent } from "./content.js";
import { errorInfo, OssKitError, ossError } from "./errors.js";
import { validateCredentials, validateStorage, validateStrategy } from "./validation.js";
function summary(c) {
    return { id: c.id, name: c.name, region: c.region, bucket: c.bucket, endpoint: c.endpoint, access: c.access, publicDomain: c.publicDomain, enabled: c.enabled, isDefault: c.isDefault, used: c.used, revision: c.revision };
}
export function createOssKit(options) {
    const app = validatePrefix(options.applicationPrefix), timeZone = validateTimeZone(options.timeZone ?? DEFAULT_TIME_ZONE);
    const max = options.maxBufferedBytes ?? HARD_MAX_SIZE_BYTES, timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(max) || max < 1 || max > HARD_MAX_SIZE_BYTES || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || typeof options.authorize !== "function" || !options.store)
        throw new OssKitError("INVALID_CONFIG");
    const testPrefixes = (options.testPrefixes ?? []).map(validatePrefix);
    const factory = options.ossTransportFactory ?? createAliyunTransport;
    async function allowed(ctx, req) {
        try {
            return await options.authorize(ctx, req) === true;
        }
        catch {
            return false;
        }
    }
    async function requireAuth(ctx, req) { if (!await allowed(ctx, req))
        throw new OssKitError("FORBIDDEN"); }
    async function stored(transaction, fn) {
        try {
            return await (transaction ? options.store.transaction(fn) : options.store.read(fn));
        }
        catch (e) {
            throw e instanceof OssKitError ? e : new OssKitError("STORE_ERROR");
        }
    }
    function security() {
        if (!options.credentials || typeof options.credentials.seal !== "function" || typeof options.credentials.open !== "function")
            throw new OssKitError("CREDENTIAL_SECURITY_REQUIRED");
        return options.credentials;
    }
    async function seal(value) {
        const protector = security();
        try {
            const envelope = await protector.seal(validateCredentials(value));
            // The host owns the cryptographic contract; also reject obvious plaintext or empty envelopes.
            if (typeof envelope !== "string" || !envelope || envelope.includes(value.accessKeySecret) || (value.stsToken && envelope.includes(value.stsToken)))
                throw new Error();
            return envelope;
        }
        catch {
            throw new OssKitError("CREDENTIAL_FAILURE");
        }
    }
    async function open(envelope) {
        const protector = security();
        try {
            return validateCredentials(await protector.open(envelope));
        }
        catch {
            throw new OssKitError("CREDENTIAL_FAILURE");
        }
    }
    async function transport(record, browser = false) {
        const credentials = await open(record.credentialEnvelope);
        try {
            return factory(summary(record), credentials, { timeoutMs: timeout, browser });
        }
        catch (e) {
            throw ossError(e);
        }
    }
    async function findStorage(v, id) {
        const c = await v.getStorage(id);
        if (!c)
            throw new OssKitError("NOT_FOUND");
        return c;
    }
    function credentialEdit(value, previous) {
        if (!value)
            return previous;
        if ((value.clearStsToken !== undefined && typeof value.clearStsToken !== "boolean") || (value.clearStsToken && value.stsToken))
            throw new OssKitError("CREDENTIAL_FAILURE");
        const token = value.clearStsToken ? undefined : value.stsToken || previous.stsToken;
        return validateCredentials({ accessKeyId: value.accessKeyId || previous.accessKeyId, accessKeySecret: value.accessKeySecret || previous.accessKeySecret, ...(token ? { stsToken: token } : {}) });
    }
    async function fileStorage(ctx, reference, operation) {
        // The host MUST resolve reference from its trusted record, and compare ownership here. Validation is not authorization.
        await requireAuth(ctx, { action: "file", operation, reference });
        if (!reference || typeof reference.storageConfigId !== "string" || typeof reference.strategyCode !== "string" || typeof reference.originalName !== "string" || !Number.isSafeInteger(reference.size) || reference.size < 1 || typeof reference.mimeType !== "string")
            throw new OssKitError("INVALID_FILE");
        validateObjectKey(reference.objectKey, app);
        return stored(false, async (v) => { const c = await findStorage(v, reference.storageConfigId); if (!c.enabled)
            throw new OssKitError("STORAGE_DISABLED"); return c; });
    }
    async function network(fn) { try {
        return await fn();
    }
    catch (e) {
        throw ossError(e);
    } }
    return {
        async createStorage(ctx, input, credentials) {
            await requireAuth(ctx, { action: "admin" });
            const normalized = validateStorage(input), envelope = await seal(credentials);
            const record = { ...normalized, id: randomUUID(), credentialEnvelope: envelope, isDefault: false, used: false, revision: 1 };
            return stored(true, async (v) => { await v.saveStorage(record); return summary(record); });
        },
        async updateStorage(ctx, id, input, credentials) {
            await requireAuth(ctx, { action: "admin" });
            const normalized = validateStorage(input);
            return stored(true, async (v) => {
                const previous = await findStorage(v, id);
                if (previous.bucket !== normalized.bucket || previous.region !== normalized.region)
                    throw new OssKitError("IMMUTABLE_LOCATION");
                if (previous.used && previous.access !== normalized.access)
                    throw new OssKitError("IMMUTABLE_ACCESS");
                const envelope = credentials && (credentials.accessKeyId || credentials.accessKeySecret || credentials.stsToken || credentials.clearStsToken) ? await seal(credentialEdit(credentials, await open(previous.credentialEnvelope))) : previous.credentialEnvelope;
                const record = { ...previous, ...normalized, credentialEnvelope: envelope, revision: previous.revision + 1, isDefault: normalized.enabled && previous.isDefault };
                await v.saveStorage(record);
                return summary(record);
            });
        },
        async listStorage(ctx) { await requireAuth(ctx, { action: "admin" }); return stored(false, async (v) => (await v.listStorage()).map(summary)); },
        async setDefaultStorage(ctx, id) {
            await requireAuth(ctx, { action: "admin" });
            await stored(true, async (v) => {
                const chosen = await findStorage(v, id);
                if (!chosen.enabled)
                    throw new OssKitError("STORAGE_DISABLED");
                // Clear first, then set; compatible with PostgreSQL's immediate partial unique index.
                for (const c of await v.listStorage())
                    if (c.isDefault && c.id !== id)
                        await v.saveStorage({ ...c, isDefault: false, revision: c.revision + 1 });
                await v.saveStorage({ ...chosen, isDefault: true, revision: chosen.revision + 1 });
            });
        },
        async setStorageEnabled(ctx, id, enabled) {
            await requireAuth(ctx, { action: "admin" });
            if (typeof enabled !== "boolean")
                throw new OssKitError("INVALID_CONFIG");
            await stored(true, async (v) => { const c = await findStorage(v, id); await v.saveStorage({ ...c, enabled, isDefault: c.isDefault && enabled, revision: c.revision + 1 }); });
        },
        async saveStrategy(ctx, input) {
            await requireAuth(ctx, { action: "admin" });
            const strategy = validateStrategy(input, max);
            return stored(true, async (v) => {
                if (strategy.storageConfigId)
                    await findStorage(v, strategy.storageConfigId);
                const previous = await v.getStrategy(strategy.code);
                strategy.used = previous?.used ?? false;
                await v.saveStrategy(strategy);
                return strategy;
            });
        },
        async listStrategies(ctx) {
            const list = await stored(false, v => v.listStrategies());
            const authorized = [];
            for (const s of list)
                if (await allowed(ctx, { action: "strategy", code: s.code }))
                    authorized.push(s);
            return authorized;
        },
        async getStrategy(ctx, code) {
            await requireAuth(ctx, { action: "strategy", code });
            return stored(false, async (v) => { const s = await v.getStrategy(code); if (!s)
                throw new OssKitError("NOT_FOUND"); return s; });
        },
        async previewStrategy(ctx, input, originalName) {
            await requireAuth(ctx, { action: "admin" });
            return previewObjectKey({ applicationPrefix: app, timeZone, strategy: validateStrategy(input, max), originalName, randomId: "00000000-0000-4000-8000-000000000000" });
        },
        async upload(ctx, input) {
            if (!input || typeof input.strategyCode !== "string")
                throw new OssKitError("INVALID_STRATEGY");
            await requireAuth(ctx, { action: "strategy", code: input.strategyCode });
            // Snapshot strategy first; actual default is resolved only for this new upload after validation.
            const strategy = await stored(false, async (v) => { const s = await v.getStrategy(input.strategyCode); if (!s)
                throw new OssKitError("NOT_FOUND"); if (!s.enabled)
                throw new OssKitError("STRATEGY_DISABLED"); return validateStrategy(s, max); });
            validatedExtension(input.originalName, strategy.allowedExtensions);
            const body = await collectBody(input.body, strategy.maxSizeBytes, timeout);
            const mimeType = await validateContent(body, input.originalName, input.mimeType, strategy);
            const { record, currentStrategy } = await stored(true, async (v) => {
                const current = await v.getStrategy(strategy.code);
                if (!current)
                    throw new OssKitError("NOT_FOUND");
                if (!current.enabled)
                    throw new OssKitError("STRATEGY_DISABLED");
                // A changed policy is revalidated before sending bytes; do not upload under a stale larger limit.
                const validated = validateStrategy(current, max);
                if (body.length > validated.maxSizeBytes)
                    throw new OssKitError("FILE_TOO_LARGE");
                await validateContent(body, input.originalName, input.mimeType, validated);
                let record;
                if (validated.storageConfigId)
                    record = await findStorage(v, validated.storageConfigId);
                else {
                    const defaults = (await v.listStorage()).filter(c => c.isDefault && c.enabled);
                    if (defaults.length > 1)
                        throw new OssKitError("STORE_ERROR");
                    record = defaults[0];
                }
                if (!record)
                    throw new OssKitError("NO_DEFAULT_STORAGE");
                if (!record.enabled)
                    throw new OssKitError("STORAGE_DISABLED");
                await v.saveStorage({ ...record, used: true });
                await v.saveStrategy({ ...current, used: true });
                return { record, currentStrategy: validated };
            });
            const key = previewObjectKey({ applicationPrefix: app, timeZone, strategy: currentStrategy, originalName: input.originalName, randomId: randomUUID() });
            const client = await transport(record);
            await network(() => client.put(key, body, mimeType, record.access === "private"));
            return { storageConfigId: record.id, strategyCode: strategy.code, objectKey: key, originalName: input.originalName, size: body.length, mimeType };
        },
        async getAccessLink(ctx, reference, linkOptions) {
            const c = await fileStorage(ctx, reference, "link");
            if (c.access === "public") {
                const origin = c.publicDomain ?? `https://${c.bucket}.${c.region}.aliyuncs.com`;
                return { url: `${origin}/${reference.objectKey.split("/").map(encodeURIComponent).join("/")}`, expiresAt: null, access: "public" };
            }
            const seconds = linkOptions?.expiresInSeconds ?? 300;
            if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 900)
                throw new OssKitError("INVALID_CONFIG");
            const client = await transport(c, true), start = Date.now();
            const url = await network(() => client.sign(reference.objectKey, seconds));
            return { url, expiresAt: new Date(start + seconds * 1000).toISOString(), access: "private" };
        },
        async read(ctx, reference) {
            const record = await fileStorage(ctx, reference, "read"), client = await transport(record);
            const source = await network(() => client.read(reference.objectKey));
            // Sanitize asynchronous stream errors too, including SDK request details.
            const output = new Readable({ read() { source.resume(); }, destroy(error, cb) { source.destroy(); cb(error); } });
            source.on("data", chunk => { if (!output.push(chunk))
                source.pause(); });
            source.once("end", () => output.push(null));
            source.once("error", error => output.destroy(ossError(error)));
            const timer = setTimeout(() => output.destroy(new OssKitError("TIMEOUT")), timeout);
            output.once("close", () => clearTimeout(timer));
            source.once("end", () => clearTimeout(timer));
            return output;
        },
        async delete(ctx, reference) { const record = await fileStorage(ctx, reference, "delete"), client = await transport(record); await network(() => client.delete(reference.objectKey)); },
        async testStorage(ctx, input) {
            await requireAuth(ctx, { action: "admin" });
            const prefix = validatePrefix(input.prefix);
            if (!testPrefixes.some(p => prefix === p || prefix.startsWith(`${p}/`)))
                throw new OssKitError("FORBIDDEN");
            const config = validateStorage(input.input);
            const previous = input.storageConfigId ? await stored(false, v => findStorage(v, input.storageConfigId)) : null;
            if (!config.enabled || previous?.enabled === false)
                throw new OssKitError("STORAGE_DISABLED");
            const creds = previous ? credentialEdit(input.credentials, await open(previous.credentialEnvelope)) : validateCredentials(input.credentials);
            // Draft tests do not persist credentials but still require configured server security.
            security();
            let client;
            try {
                client = factory({ ...config, id: previous?.id ?? "draft", isDefault: false, used: false, revision: 0 }, creds, { timeoutMs: timeout, browser: false });
            }
            catch (e) {
                throw ossError(e);
            }
            const key = `${prefix}/oss-kit-test-${randomUUID()}.txt`, body = Buffer.from(`oss-kit-connection-test:${randomUUID()}`);
            const result = { objectKey: key, upload: { status: "skipped" }, read: { status: "skipped" }, delete: { status: "skipped" }, cleanupRequired: false };
            async function step(fn) { try {
                await network(fn);
                return { status: "passed" };
            }
            catch (e) {
                return { status: "failed", error: errorInfo(e) };
            } }
            result.upload = await step(() => client.put(key, body, "text/plain", config.access === "private"));
            if (result.upload.status === "passed")
                result.read = await step(async () => { const read = await client.get(key); if (!Buffer.isBuffer(read) || !read.equals(body))
                    throw new OssKitError("TYPE_MISMATCH"); });
            // Even a failed PUT may have reached OSS. Only this random object is eligible for cleanup.
            result.delete = await step(() => client.delete(key));
            result.cleanupRequired = result.delete.status !== "passed";
            return result;
        },
    };
}
