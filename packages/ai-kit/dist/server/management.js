import { randomUUID } from "node:crypto";
import { modelPresets, providerAdapters, providerDictionaryType, seedProviderDictionary, } from "../catalog.js";
import { AiKitError } from "./errors.js";
import { createSafeTransport, validateBaseURL } from "./network.js";
import { connectionSchema, defaultLimits, parse, planSchema, validateParameters, } from "./validation.js";
export function createManagement(options) {
    const limits = { ...defaultLimits, ...options.limits };
    function summary(c) {
        const { credentialEnvelope, ...rest } = c;
        return { ...rest, hasCredential: !!credentialEnvelope };
    }
    async function authorize(ctx, request) {
        let approved = false;
        try {
            approved = await options.authorize(ctx, request);
        }
        catch {
            /* fail closed */
        }
        if (!approved)
            throw new AiKitError("FORBIDDEN");
    }
    async function gate(ctx, request) {
        await authorize(ctx, request);
        let permitted = false;
        try {
            permitted = await options.rateLimit(ctx, request.action);
        }
        catch {
            /* fail closed */
        }
        if (!permitted)
            throw new AiKitError("RATE_LIMITED");
    }
    function adapter(providerCode, protocol) {
        const a = providerAdapters.find((x) => x.code === providerCode);
        if (!a)
            throw new AiKitError("UNSUPPORTED_PROVIDER");
        if (!a.protocols.some((x) => x === protocol))
            throw new AiKitError("UNSUPPORTED_PROTOCOL");
        return a;
    }
    async function capabilities(providerCode, modelId) {
        const custom = await options.resolveModelCapabilities?.(providerCode, modelId);
        const preset = modelPresets.find((x) => x.providerCode === providerCode && x.modelId === modelId);
        const c = custom ?? preset;
        if (!c)
            throw new AiKitError("MODEL_CAPABILITIES_REQUIRED");
        return c;
    }
    async function verifyAddress(url) {
        const transport = await createSafeTransport(url, options.allowURL, options.transport, limits.maxResponseBytes);
        await transport.close();
    }
    async function validateConnection(input, previous, id) {
        adapter(input.providerCode, input.protocol);
        const url = validateBaseURL(input.baseURL);
        if (previous &&
            (new URL(previous.baseURL).origin !== url.origin ||
                previous.providerCode !== input.providerCode) &&
            !input.confirmKeyDomainChange)
            throw new AiKitError("KEY_DOMAIN_CONFIRMATION_REQUIRED");
        const providers = await options.dictionary.listItems(providerDictionaryType);
        if (!providers.some((p) => p.code === input.providerCode && p.enabled))
            throw new AiKitError("INVALID_CONFIG");
        await verifyAddress(url.href);
        let envelope = previous?.credentialEnvelope;
        if (input.apiKey) {
            try {
                envelope = await options.secrets.seal(input.apiKey, `${options.scope}:${id}`);
            }
            catch (error) {
                if (error instanceof AiKitError)
                    throw error;
                throw new AiKitError("CREDENTIAL_FAILURE");
            }
        }
        if (!envelope)
            throw new AiKitError("CREDENTIAL_SECURITY_REQUIRED");
        return {
            id,
            name: input.name,
            providerCode: input.providerCode,
            protocol: input.protocol,
            baseURL: url.href.replace(/\/$/, ""),
            credentialEnvelope: envelope,
            enabled: input.enabled,
            revision: (previous?.revision ?? 0) + 1,
            testedRevision: null,
        };
    }
    async function clearDefaults(view, except) {
        for (const p of await view.listPlans())
            if (p.isDefault && p.code !== except)
                await view.savePlan({
                    ...p,
                    isDefault: false,
                    revision: p.revision + 1,
                });
    }
    return {
        options,
        limits,
        summary,
        authorize,
        gate,
        adapter,
        capabilities,
        validateConnection,
        async listProviders(ctx) {
            await gate(ctx, { action: "dictionary" });
            return options.dictionary.listItems(providerDictionaryType);
        },
        async initializeDictionary(ctx) {
            await gate(ctx, { action: "admin" });
            await seedProviderDictionary(options.dictionary);
        },
        async listConnections(ctx) {
            await gate(ctx, { action: "admin" });
            return options.store.read(async (v) => (await v.listConnections()).map(summary));
        },
        async saveConnection(ctx, raw) {
            await gate(ctx, { action: "admin" });
            const input = parse(connectionSchema, raw);
            return options.store.transaction(async (v) => {
                const previous = input.id ? await v.getConnection(input.id) : null;
                if (input.id && !previous)
                    throw new AiKitError("NOT_FOUND");
                if (previous && previous.revision !== input.revision)
                    throw new AiKitError("CONFLICT");
                const c = await validateConnection(input, previous, previous?.id ?? randomUUID());
                const defaults = (await v.listPlans()).filter((p) => p.connectionId === c.id && p.isDefault);
                if (!c.enabled && defaults.length) {
                    if (!input.clearDefault)
                        throw new AiKitError("DEFAULT_REQUIRES_ACTION");
                    for (const p of defaults)
                        await v.savePlan({
                            ...p,
                            isDefault: false,
                            revision: p.revision + 1,
                        });
                }
                await v.saveConnection(c);
                return summary(c);
            });
        },
        async deleteConnection(ctx, id, revision) {
            await gate(ctx, { action: "admin" });
            await options.store.transaction(async (v) => {
                const c = await v.getConnection(id);
                if (!c)
                    throw new AiKitError("NOT_FOUND");
                if (c.revision !== revision)
                    throw new AiKitError("CONFLICT");
                if ((await v.listPlans()).some((p) => p.connectionId === id))
                    throw new AiKitError("CONNECTION_IN_USE");
                await v.deleteConnection(id);
            });
        },
        async listPlans(ctx) {
            await gate(ctx, { action: "admin" });
            return options.store.read((v) => v.listPlans());
        },
        async savePlan(ctx, raw) {
            await gate(ctx, { action: "admin" });
            const input = parse(planSchema, raw);
            return options.store.transaction(async (v) => {
                const plans = await v.listPlans(), previous = input.id
                    ? plans.find((p) => p.id === input.id)
                    : undefined;
                if (input.id && !previous)
                    throw new AiKitError("NOT_FOUND");
                if (previous &&
                    (previous.revision !== input.revision || previous.code !== input.code))
                    throw new AiKitError("CONFLICT");
                if (!previous && plans.some((p) => p.code === input.code))
                    throw new AiKitError("CONFLICT");
                const c = await v.getConnection(input.connectionId);
                if (!c)
                    throw new AiKitError("NOT_FOUND");
                if (input.isDefault && (!input.enabled || !c.enabled))
                    throw new AiKitError("DEFAULT_REQUIRES_ACTION");
                const known = (await options.resolveModelCapabilities?.(c.providerCode, input.modelId)) ??
                    modelPresets.find((x) => x.providerCode === c.providerCode && x.modelId === input.modelId);
                if (known)
                    validateParameters(input.parameters ?? {}, known, limits);
                const plan = {
                    ...input,
                    id: previous?.id ?? randomUUID(),
                    revision: (previous?.revision ?? 0) + 1,
                    parameters: input.parameters ?? {},
                    systemPrompt: input.systemPrompt ?? null,
                };
                if (input.isDefault)
                    await clearDefaults(v, input.code);
                await v.savePlan(plan);
                return plan;
            });
        },
        async setDefault(ctx, code) {
            await gate(ctx, { action: "admin" });
            await options.store.transaction(async (v) => {
                if (code !== null) {
                    const p = await v.getPlan(code);
                    if (!p)
                        throw new AiKitError("NOT_FOUND");
                    const c = await v.getConnection(p.connectionId);
                    if (!p.enabled || !c?.enabled)
                        throw new AiKitError("DISABLED");
                    await clearDefaults(v, code);
                    if (!p.isDefault)
                        await v.savePlan({
                            ...p,
                            isDefault: true,
                            revision: p.revision + 1,
                        });
                }
                else
                    await clearDefaults(v);
            });
        },
        async listAuthorizedPlans(ctx) {
            // Query authorization is evaluated for every real plan; no configuration details escape.
            let permitted = false;
            try {
                permitted = await options.rateLimit(ctx, "query");
            }
            catch {
                /* fail closed */
            }
            if (!permitted)
                throw new AiKitError("RATE_LIMITED");
            const plans = await options.store.read(async (v) => {
                const ps = await v.listPlans(), cs = await v.listConnections();
                return ps
                    .filter((p) => p.enabled)
                    .flatMap((p) => {
                    const c = cs.find((c) => c.id === p.connectionId && c.enabled);
                    return c
                        ? [
                            {
                                code: p.code,
                                name: p.name,
                                modelId: p.modelId,
                                providerCode: c.providerCode,
                                isDefault: p.isDefault,
                            },
                        ]
                        : [];
                });
            });
            const result = [];
            for (const p of plans) {
                try {
                    await authorize(ctx, { action: "query", code: p.code });
                    result.push(p);
                }
                catch (error) {
                    if (!(error instanceof AiKitError) || error.code !== "FORBIDDEN")
                        throw error;
                }
            }
            return result;
        },
    };
}
