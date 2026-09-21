import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { AiKitError } from "./errors.js";
function checked(model) {
    function check(warnings) {
        if (warnings?.some((w) => w.type === "unsupported"))
            throw new AiKitError("UNSUPPORTED_PARAMETER");
    }
    return wrapLanguageModel({
        model,
        middleware: {
            async wrapGenerate({ doGenerate }) {
                const result = await doGenerate();
                check(result.warnings);
                return { ...result, warnings: [] };
            },
            async wrapStream({ doStream }) {
                const result = await doStream();
                return {
                    ...result,
                    stream: result.stream.pipeThrough(new TransformStream({
                        transform(part, controller) {
                            if (part.type === "stream-start") {
                                check(part.warnings);
                                controller.enqueue({ ...part, warnings: [] });
                            }
                            else
                                controller.enqueue(part);
                        },
                    })),
                };
            },
        },
    });
}
export function buildProvider(connection, modelId, key, fetch, parameters) {
    if (parameters.thinking !== undefined &&
        !["qwen", "glm", "deepseek"].includes(connection.providerCode))
        throw new AiKitError("UNSUPPORTED_PARAMETER");
    const common = { baseURL: connection.baseURL, apiKey: key, fetch };
    if (connection.protocol === "anthropic-messages")
        return {
            model: checked(createAnthropic(common)(modelId)),
            providerOptions: {},
        };
    if (connection.protocol === "openai-responses")
        return {
            model: checked(createOpenAI(common).responses(modelId)),
            providerOptions: { openai: { store: false } },
        };
    if (connection.providerCode === "openai")
        return {
            model: checked(createOpenAI(common).chat(modelId)),
            providerOptions: { openai: { store: false } },
        };
    const provider = createOpenAICompatible({
        name: connection.providerCode,
        baseURL: connection.baseURL,
        fetch,
        includeUsage: true,
        ...(connection.providerCode === "mimo"
            ? { headers: { "api-key": key } }
            : { apiKey: key }),
        transformRequestBody(args) {
            // Small, documented field adapters; SDK still owns messages, responses and SSE.
            const body = { ...args };
            if (connection.providerCode === "mimo" && body.max_tokens !== undefined) {
                body.max_completion_tokens = body.max_tokens;
                delete body.max_tokens;
            }
            if (parameters.thinking !== undefined) {
                if (connection.providerCode === "qwen")
                    body.enable_thinking = parameters.thinking === "enabled";
                else if (connection.providerCode === "glm" ||
                    connection.providerCode === "deepseek")
                    body.thinking = { type: parameters.thinking };
            }
            return body;
        },
    });
    return { model: checked(provider.chatModel(modelId)), providerOptions: {} };
}
