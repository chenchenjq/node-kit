import { z } from "zod";
import type { GenerationParameters, ModelCapabilities } from "../types.js";
import type { HostLimits } from "./contracts.js";
export declare const parametersSchema: z.ZodObject<{
    temperature: z.ZodOptional<z.ZodNumber>;
    topP: z.ZodOptional<z.ZodNumber>;
    maxOutputTokens: z.ZodOptional<z.ZodNumber>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
    maxRetries: z.ZodOptional<z.ZodNumber>;
    thinking: z.ZodOptional<z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
    }>>;
}, z.core.$strict>;
export declare const connectionSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    revision: z.ZodOptional<z.ZodNumber>;
    name: z.ZodString;
    providerCode: z.ZodString;
    protocol: z.ZodEnum<{
        "anthropic-messages": "anthropic-messages";
        "openai-chat": "openai-chat";
        "openai-responses": "openai-responses";
    }>;
    baseURL: z.ZodString;
    apiKey: z.ZodOptional<z.ZodString>;
    enabled: z.ZodBoolean;
    confirmKeyDomainChange: z.ZodOptional<z.ZodBoolean>;
    clearDefault: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const planSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    revision: z.ZodOptional<z.ZodNumber>;
    code: z.ZodString;
    name: z.ZodString;
    connectionId: z.ZodString;
    modelId: z.ZodString;
    enabled: z.ZodBoolean;
    isDefault: z.ZodBoolean;
    systemPrompt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    parameters: z.ZodOptional<z.ZodObject<{
        temperature: z.ZodOptional<z.ZodNumber>;
        topP: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRetries: z.ZodOptional<z.ZodNumber>;
        thinking: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            enabled: "enabled";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const callSchema: z.ZodObject<{
    code: z.ZodOptional<z.ZodString>;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<{
            assistant: "assistant";
            system: "system";
            user: "user";
        }>;
        content: z.ZodString;
    }, z.core.$strict>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        temperature: z.ZodOptional<z.ZodNumber>;
        topP: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRetries: z.ZodOptional<z.ZodNumber>;
        thinking: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            enabled: "enabled";
        }>>;
    }, z.core.$strict>>;
    signal: z.ZodOptional<z.ZodCustom<AbortSignal, AbortSignal>>;
}, z.core.$strict>;
export declare const draftSchema: z.ZodObject<{
    connection: z.ZodObject<{
        id: z.ZodOptional<z.ZodString>;
        revision: z.ZodOptional<z.ZodNumber>;
        name: z.ZodString;
        providerCode: z.ZodString;
        protocol: z.ZodEnum<{
            "anthropic-messages": "anthropic-messages";
            "openai-chat": "openai-chat";
            "openai-responses": "openai-responses";
        }>;
        baseURL: z.ZodString;
        apiKey: z.ZodOptional<z.ZodString>;
        enabled: z.ZodBoolean;
        confirmKeyDomainChange: z.ZodOptional<z.ZodBoolean>;
        clearDefault: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>;
    modelId: z.ZodString;
    parameters: z.ZodOptional<z.ZodObject<{
        temperature: z.ZodOptional<z.ZodNumber>;
        topP: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRetries: z.ZodOptional<z.ZodNumber>;
        thinking: z.ZodOptional<z.ZodEnum<{
            disabled: "disabled";
            enabled: "enabled";
        }>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const defaultLimits: HostLimits;
export declare function parse<T>(schema: z.ZodType<T>, value: unknown): T;
export declare function validateParameters(input: GenerationParameters, caps: ModelCapabilities, limits: HostLimits): {
    temperature?: number | undefined;
    topP?: number | undefined;
    thinking?: "disabled" | "enabled" | undefined;
    maxOutputTokens: number;
    timeoutMs: number;
    maxRetries: number;
};
