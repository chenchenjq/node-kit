import { z } from "zod";
import { AiKitError } from "./errors.js";
const id = z.string().min(1).max(100), code = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/), revision = z.number().int().positive();
export const parametersSchema = z.strictObject({
    temperature: z.number().finite().optional(),
    topP: z.number().finite().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().min(0).max(3).optional(),
    thinking: z.enum(["enabled", "disabled"]).optional(),
});
export const connectionSchema = z.strictObject({
    id: id.optional(),
    revision: revision.optional(),
    name: z.string().trim().min(1).max(100),
    providerCode: code,
    protocol: z.enum(["openai-chat", "openai-responses", "anthropic-messages"]),
    baseURL: z.string().min(1).max(2000),
    apiKey: z.string().max(4096).optional(),
    enabled: z.boolean(),
    confirmKeyDomainChange: z.boolean().optional(),
    clearDefault: z.boolean().optional(),
});
export const planSchema = z.strictObject({
    id: id.optional(),
    revision: revision.optional(),
    code,
    name: z.string().trim().min(1).max(100),
    connectionId: id,
    modelId: z
        .string()
        .min(1)
        .max(200)
        .refine((s) => s === s.trim() && !/[\x00-\x1f]/.test(s)),
    enabled: z.boolean(),
    isDefault: z.boolean(),
    systemPrompt: z.string().max(20000).nullable().optional(),
    parameters: parametersSchema.optional(),
});
export const callSchema = z.strictObject({
    code: code.optional(),
    messages: z
        .array(z.strictObject({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
    }))
        .min(1),
    systemPrompt: z.string().optional(),
    options: parametersSchema.optional(),
    signal: z.custom((x) => x instanceof AbortSignal).optional(),
});
export const draftSchema = z.strictObject({
    connection: connectionSchema,
    modelId: planSchema.shape.modelId,
    parameters: parametersSchema.optional(),
});
export const defaultLimits = {
    maxInputCharacters: 32000,
    maxMessages: 64,
    maxOutputTokens: 4096,
    maxOutputCharacters: 64000,
    maxResponseBytes: 2_000_000,
    maxTimeoutMs: 120000,
    maxRetries: 1,
};
export function parse(schema, value) {
    const result = schema.safeParse(value);
    if (!result.success)
        throw new AiKitError("INVALID_INPUT");
    return result.data;
}
export function validateParameters(input, caps, limits) {
    const p = {
        ...parse(parametersSchema, input),
        maxOutputTokens: input.maxOutputTokens ??
            Math.min(1024, caps.maxOutputTokens, limits.maxOutputTokens),
        timeoutMs: input.timeoutMs ?? Math.min(60000, limits.maxTimeoutMs),
        maxRetries: input.maxRetries ?? 0,
    };
    if (!Number.isSafeInteger(caps.maxOutputTokens) ||
        caps.maxOutputTokens < 1 ||
        p.maxOutputTokens > caps.maxOutputTokens ||
        p.maxOutputTokens > limits.maxOutputTokens ||
        p.timeoutMs > limits.maxTimeoutMs ||
        p.maxRetries > limits.maxRetries)
        throw new AiKitError("UNSUPPORTED_PARAMETER");
    for (const [name, range] of [
        ["temperature", caps.temperature],
        ["topP", caps.topP],
    ]) {
        const value = p[name];
        if (value !== undefined &&
            (!range ||
                value < range.min ||
                value > range.max ||
                (range.exclusiveMax && value === range.max) ||
                (range.decimals !== undefined &&
                    Math.abs(value * 10 ** range.decimals -
                        Math.round(value * 10 ** range.decimals)) > 1e-8)))
            throw new AiKitError("UNSUPPORTED_PARAMETER");
    }
    if (p.thinking !== undefined && !caps.thinking)
        throw new AiKitError("UNSUPPORTED_PARAMETER");
    return p;
}
