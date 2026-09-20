import { generateText, streamText } from "ai";
import { AiKitError, sanitizeError } from "./errors.js";
import { callSchema, draftSchema, parse, validateParameters, } from "./validation.js";
import { createSafeTransport } from "./network.js";
import { buildProvider } from "./provider.js";
import { randomUUID } from "node:crypto";
function usage(u) {
    if (!u ||
        [
            u.inputTokens,
            u.outputTokens,
            u.totalTokens,
            u.outputTokenDetails?.reasoningTokens,
        ].every((x) => x === undefined))
        return null;
    const number = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
    const raw = u.raw;
    if (raw) {
        const chat = "prompt_tokens" in raw || "completion_tokens" in raw;
        const input = number(chat
            ? raw.prompt_tokens
            : raw.input_tokens !== undefined
                ? u.inputTokens
                : undefined);
        const output = number(chat ? raw.completion_tokens : raw.output_tokens);
        const details = (raw.completion_tokens_details ??
            raw.output_tokens_details);
        const reasoning = number(details?.reasoning_tokens ??
            details?.thinking_tokens ??
            raw.reasoning_tokens);
        const total = number(raw.total_tokens) ??
            (input !== null && output !== null ? input + output : null);
        if (input === null &&
            output === null &&
            total === null &&
            reasoning === null)
            return null;
        return {
            inputTokens: input,
            outputTokens: output,
            totalTokens: total,
            reasoningTokens: reasoning,
        };
    }
    return {
        inputTokens: number(u.inputTokens),
        outputTokens: number(u.outputTokens),
        totalTokens: number(u.totalTokens),
        reasoningTokens: number(u.outputTokenDetails?.reasoningTokens),
    };
}
function deadline(timeoutMs, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted)
        abort();
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    timer.unref();
    return {
        controller,
        error: (e) => controller.signal.aborted
            ? new AiKitError(timedOut ? "TIMEOUT" : "CANCELLED")
            : sanitizeError(e),
        close() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            controller.abort();
        },
    };
}
async function abortable(promise, signal) {
    if (signal.aborted)
        throw new AiKitError("CANCELLED");
    let remove = () => { };
    try {
        return await Promise.race([
            promise,
            new Promise((_r, reject) => {
                const onAbort = () => reject(new AiKitError("CANCELLED"));
                signal.addEventListener("abort", onAbort, { once: true });
                remove = () => signal.removeEventListener("abort", onAbort);
            }),
        ]);
    }
    finally {
        remove();
    }
}
export function createGeneration(m) {
    const { options, limits } = m;
    async function snapshot(ctx, raw) {
        const input = parse(callSchema, raw);
        if (input.signal?.aborted)
            throw new AiKitError("CANCELLED");
        if (input.messages.length > limits.maxMessages ||
            input.messages.reduce((n, x) => n + x.content.length, 0) +
                (input.systemPrompt?.length ?? 0) >
                limits.maxInputCharacters)
            throw new AiKitError("INVALID_INPUT");
        // An explicit code must be authorized before looking it up.
        if (input.code !== undefined)
            await m.gate(ctx, { action: "generate", code: input.code });
        const pair = await options.store.read(async (v) => {
            const p = input.code !== undefined
                ? await v.getPlan(input.code)
                : ((await v.listPlans()).find((p) => p.enabled && p.isDefault) ??
                    null);
            if (!p)
                throw new AiKitError(input.code !== undefined ? "NOT_FOUND" : "NO_DEFAULT_PLAN");
            const c = await v.getConnection(p.connectionId);
            if (!c)
                throw new AiKitError("NOT_FOUND");
            return { plan: p, connection: c };
        });
        if (input.code === undefined)
            await m.gate(ctx, { action: "generate", code: pair.plan.code });
        if (!pair.plan.enabled || !pair.connection.enabled)
            throw new AiKitError("DISABLED");
        if (input.options && Object.keys(input.options).length)
            await m.authorize(ctx, { action: "override", code: pair.plan.code });
        if (input.systemPrompt !== undefined ||
            input.messages.some((x) => x.role === "system"))
            await m.authorize(ctx, { action: "system", code: pair.plan.code });
        m.adapter(pair.connection.providerCode, pair.connection.protocol);
        const caps = await m.capabilities(pair.connection.providerCode, pair.plan.modelId);
        const parameters = validateParameters({ ...pair.plan.parameters, ...input.options }, caps, limits);
        const defaultSystem = input.systemPrompt ??
            (input.messages.some((x) => x.role === "system")
                ? undefined
                : (pair.plan.systemPrompt ?? undefined));
        if (input.messages.reduce((n, x) => n + x.content.length, 0) +
            (defaultSystem?.length ?? 0) >
            limits.maxInputCharacters)
            throw new AiKitError("INVALID_INPUT");
        return {
            ...structuredClone(pair),
            parameters,
            input: {
                ...input,
                ...(defaultSystem !== undefined ? { systemPrompt: defaultSystem } : {}),
            },
        };
    }
    async function prepare(s, d) {
        const pending = createSafeTransport(s.connection.baseURL, options.allowURL, options.transport, limits.maxResponseBytes);
        let transport;
        try {
            transport = await abortable(pending, d.controller.signal);
        }
        catch (error) {
            void pending.then((t) => t.close(), () => { });
            throw error;
        }
        try {
            const key = await abortable(options.secrets.open(s.connection.credentialEnvelope, `${options.scope}:${s.connection.id}`), d.controller.signal);
            if (!key || key.length > 4096 || /[\r\n]/.test(key))
                throw new AiKitError("CREDENTIAL_FAILURE");
            return {
                transport,
                ...buildProvider(s.connection, s.plan.modelId, key, transport.fetch, s.parameters),
            };
        }
        catch (error) {
            await transport.close();
            if (d.controller.signal.aborted)
                throw error;
            if (error instanceof AiKitError)
                throw error;
            throw new AiKitError("CREDENTIAL_FAILURE");
        }
    }
    function sdkInput(s, p, signal) {
        return {
            model: p.model,
            messages: s.input.messages,
            allowSystemInMessages: true,
            ...(s.input.systemPrompt !== undefined
                ? { system: s.input.systemPrompt }
                : {}),
            ...(s.parameters.temperature !== undefined
                ? { temperature: s.parameters.temperature }
                : {}),
            ...(s.parameters.topP !== undefined ? { topP: s.parameters.topP } : {}),
            maxOutputTokens: s.parameters.maxOutputTokens,
            maxRetries: 0,
            abortSignal: signal,
            providerOptions: p.providerOptions,
        };
    }
    function result(s, start, text, reasoning, finishReason, u, response) {
        if (text.length + reasoning.length > limits.maxOutputCharacters)
            throw new AiKitError("OUTPUT_LIMIT");
        const requestId = response?.headers?.["x-request-id"] ??
            response?.headers?.["request-id"] ??
            response?.id ??
            null;
        return {
            text,
            reasoning,
            code: s.plan.code,
            providerCode: s.connection.providerCode,
            modelId: response?.modelId ?? s.plan.modelId,
            status: text.trim() && finishReason === "stop" ? "completed" : "incomplete",
            finishReason,
            durationMs: Date.now() - start,
            requestId: requestId && /^[a-zA-Z0-9._:-]{1,200}$/.test(requestId)
                ? requestId
                : null,
            usage: usage(u),
        };
    }
    function log(s, start, status, u = null) {
        try {
            options.log?.({
                status,
                code: s.plan.code,
                providerCode: s.connection.providerCode,
                modelId: s.plan.modelId,
                durationMs: Date.now() - start,
                usage: u,
            });
        }
        catch {
            /* logging cannot replay an AI request */
        }
    }
    async function run(s) {
        const start = Date.now(), d = deadline(s.parameters.timeoutMs, s.input.signal);
        let transport;
        try {
            const p = await prepare(s, d);
            transport = p.transport;
            for (let attempt = 0;; attempt++) {
                try {
                    const r = await abortable(generateText(sdkInput(s, p, d.controller.signal)), d.controller.signal);
                    const output = result(s, start, r.text, r.reasoningText ?? "", r.finishReason, r.finalStep.usage, r.response);
                    log(s, start, output.status, output.usage);
                    return output;
                }
                catch (error) {
                    const safe = d.error(error);
                    if (safe.code !== "RATE_LIMITED" ||
                        attempt >= s.parameters.maxRetries)
                        throw safe;
                    await abortable(new Promise((resolve) => setTimeout(resolve, Math.min(100 * (attempt + 1), 1000))), d.controller.signal);
                }
            }
        }
        catch (error) {
            const safe = d.error(error);
            log(s, start, safe.code);
            throw safe;
        }
        finally {
            d.close();
            await transport?.close();
        }
    }
    async function* stream(ctx, raw) {
        let s, transport, d;
        const start = Date.now();
        let startedOutput = false;
        try {
            s = await snapshot(ctx, raw);
            d = deadline(s.parameters.timeoutMs, s.input.signal);
            const p = await prepare(s, d);
            transport = p.transport;
            const streamed = streamText({
                ...sdkInput(s, p, d.controller.signal),
                onError: () => { },
            });
            let text = "", reasoning = "", reason, u, response;
            // No stream retry, including pre-output failures: consumers can make an explicit new request.
            const iterator = streamed.fullStream[Symbol.asyncIterator]();
            try {
                for (;;) {
                    const next = await abortable(iterator.next(), d.controller.signal);
                    if (next.done)
                        break;
                    const part = next.value;
                    if (d.controller.signal.aborted)
                        throw d.error(null);
                    if (part.type === "error")
                        throw part.error;
                    if (part.type === "abort")
                        throw d.error(new AiKitError("CANCELLED"));
                    if (part.type === "text-delta" || part.type === "reasoning-delta") {
                        if (part.type === "text-delta")
                            text += part.text;
                        else
                            reasoning += part.text;
                        if (text.length + reasoning.length > limits.maxOutputCharacters)
                            throw new AiKitError("OUTPUT_LIMIT");
                        startedOutput = true;
                        yield { type: part.type, delta: part.text };
                    }
                    if (part.type === "finish-step") {
                        reason = part.finishReason;
                        u = part.usage;
                        response = part.response;
                    }
                }
            }
            finally {
                void iterator.return?.().catch(() => { });
            }
            if (!reason || reason === "unknown" || reason === "error")
                throw new AiKitError("STREAM_INTERRUPTED");
            const final = result(s, start, text, reasoning, reason, u, response);
            log(s, start, final.status, final.usage);
            yield { type: "finish", result: final };
        }
        catch (error) {
            let safe = d ? d.error(error) : sanitizeError(error);
            if (startedOutput && safe.code === "NETWORK")
                safe = new AiKitError("STREAM_INTERRUPTED");
            if (s)
                log(s, start, safe.code);
            yield { type: "error", error: safe.toJSON() };
        }
        finally {
            d?.close();
            await transport?.close();
        }
    }
    const testMessage = [
        { role: "user", content: "Reply with only OK." },
    ];
    async function test(s) {
        const start = Date.now();
        try {
            const r = await run(s);
            return {
                result: r,
                error: null,
                status: r.status,
                durationMs: Date.now() - start,
            };
        }
        catch (error) {
            return {
                result: null,
                error: sanitizeError(error).toJSON(),
                status: "failed",
                durationMs: Date.now() - start,
            };
        }
    }
    return {
        async generate(ctx, input) {
            return run(await snapshot(ctx, input));
        },
        stream,
        async testPlan(ctx, code, signal) {
            await m.gate(ctx, { action: "test" });
            // Tests intentionally ignore business system prompts. They still validate all stored generation parameters.
            const s = await snapshot(ctx, {
                code,
                messages: testMessage,
                systemPrompt: "Reply briefly.",
                ...(signal ? { signal } : {}),
            });
            s.parameters.maxOutputTokens = Math.min(s.parameters.maxOutputTokens, 128);
            s.parameters.maxRetries = 0;
            const outcome = await test(s);
            if (outcome.status === "completed")
                await options.store.transaction(async (v) => {
                    const c = await v.getConnection(s.connection.id), p = await v.getPlan(s.plan.code);
                    if (c?.revision === s.connection.revision &&
                        p?.revision === s.plan.revision)
                        await v.saveConnection({ ...c, testedRevision: c.revision });
                });
            return outcome;
        },
        async testDraft(ctx, raw, signal) {
            await m.gate(ctx, { action: "test" });
            const input = parse(draftSchema, raw);
            const start = Date.now(), d = deadline(Math.min(input.parameters?.timeoutMs ?? 60000, limits.maxTimeoutMs), signal);
            try {
                if (d.controller.signal.aborted)
                    throw d.error(null);
                const previous = input.connection.id
                    ? await abortable(options.store.read((v) => v.getConnection(input.connection.id)), d.controller.signal)
                    : null;
                if (input.connection.id &&
                    (!previous || previous.revision !== input.connection.revision))
                    throw new AiKitError("CONFLICT");
                const connection = await abortable(m.validateConnection(input.connection, previous, previous?.id ?? randomUUID()), d.controller.signal);
                const caps = await abortable(m.capabilities(connection.providerCode, input.modelId), d.controller.signal);
                const parameters = validateParameters(input.parameters ?? {}, caps, limits);
                parameters.maxOutputTokens = Math.min(parameters.maxOutputTokens, 128);
                parameters.maxRetries = 0;
                const plan = {
                    id: "draft",
                    revision: 1,
                    code: "draft-test",
                    name: "draft",
                    connectionId: connection.id,
                    modelId: input.modelId,
                    enabled: true,
                    isDefault: false,
                    parameters: input.parameters ?? {},
                    systemPrompt: null,
                };
                const outcome = await test({
                    connection,
                    plan,
                    parameters,
                    input: { messages: testMessage, signal: d.controller.signal },
                });
                if (d.controller.signal.aborted)
                    throw d.error(null);
                return outcome;
            }
            catch (error) {
                return {
                    result: null,
                    error: d.error(error).toJSON(),
                    status: "failed",
                    durationMs: Date.now() - start,
                };
            }
            finally {
                d.close();
            }
        },
        async refreshModels(ctx, connectionId, signal) {
            await m.gate(ctx, { action: "admin" });
            const c = await options.store.read((v) => v.getConnection(connectionId));
            if (!c)
                throw new AiKitError("NOT_FOUND");
            const adapter = m.adapter(c.providerCode, c.protocol);
            if (!adapter.modelsPath)
                throw new AiKitError("MODEL_REFRESH_UNSUPPORTED");
            const d = deadline(Math.min(60000, limits.maxTimeoutMs), signal);
            let t;
            try {
                const pending = createSafeTransport(c.baseURL, options.allowURL, options.transport, limits.maxResponseBytes);
                try {
                    t = await abortable(pending, d.controller.signal);
                }
                catch (error) {
                    void pending.then((transport) => transport.close(), () => { });
                    throw error;
                }
                let key;
                try {
                    key = await abortable(options.secrets.open(c.credentialEnvelope, `${options.scope}:${c.id}`), d.controller.signal);
                }
                catch (error) {
                    if (d.controller.signal.aborted)
                        throw error;
                    throw new AiKitError("CREDENTIAL_FAILURE");
                }
                if (!key || key.length > 4096 || /[\r\n]/.test(key))
                    throw new AiKitError("CREDENTIAL_FAILURE");
                const response = await abortable(t.fetch(`${c.baseURL}${adapter.modelsPath}`, {
                    headers: c.protocol === "anthropic-messages"
                        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
                        : { authorization: `Bearer ${key}` },
                    signal: d.controller.signal,
                }), d.controller.signal);
                if (!response.ok)
                    throw { status: response.status };
                const data = (await abortable(response.json(), d.controller.signal));
                if (!Array.isArray(data.data) || data.data.length > 2000)
                    throw new AiKitError("PROVIDER_ERROR");
                return data.data.flatMap((x) => typeof x.id === "string" && x.id.length <= 200 ? [x.id] : []);
            }
            catch (error) {
                throw d.error(error);
            }
            finally {
                d.close();
                await t?.close();
            }
        },
    };
}
