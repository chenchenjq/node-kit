export const providerDictionaryType = "ai_model_provider";
export const providerSeeds = [
    ["qwen", "阿里千问"],
    ["glm", "智谱 GLM"],
    ["mimo", "小米 MiMo"],
    ["kimi", "月之暗面 Kimi"],
    ["minimax", "MiniMax"],
    ["deepseek", "DeepSeek"],
    ["openai", "OpenAI"],
    ["claude", "Anthropic（Claude）"],
    ["grok", "xAI（Grok）"],
].map(([code, name], sort) => ({
    code: code,
    name: name,
    sort,
    enabled: true,
}));
/** The host must enforce unique(type,code) and insert-if-absent atomically. */
export async function seedProviderDictionary(port) {
    await port.insertTypeIfAbsent(providerDictionaryType, "AI模型厂商");
    for (const item of providerSeeds)
        await port.insertItemIfAbsent(providerDictionaryType, { ...item });
}
const chat = "openai-chat", responses = "openai-responses", messages = "anthropic-messages";
const sources = {
    qwen: "https://help.aliyun.com/zh/model-studio/qwen-plus",
    glm: "https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2",
    mimo: "https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call",
    kimi: "https://platform.kimi.ai/docs/api/models-overview",
    minimax: "https://platform.minimax.io/docs/api-reference/text-anthropic-api",
    deepseek: "https://api-docs.deepseek.com/quick_start/pricing/",
    openai: "https://developers.openai.com/api/docs/models/gpt-5.4",
    claude: "https://platform.claude.com/docs/en/models/overview",
    grok: "https://docs.x.ai/developers/models/grok-4.6",
};
function adapter(code, protocol, baseURL, modelsPath, more = []) {
    return {
        code,
        protocols: code === "openai" ? [chat, responses] : [protocol],
        recommendedProtocol: protocol,
        endpoints: [
            {
                name: "普通 API",
                baseURL,
                protocol,
                purpose: "ordinary",
                source: sources[code],
            },
            ...more,
        ],
        modelsPath,
    };
}
export const providerAdapters = [
    adapter("qwen", chat, "https://dashscope.aliyuncs.com/compatible-mode/v1", null, [
        {
            name: "新加坡普通 API",
            baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            protocol: chat,
            purpose: "ordinary",
            source: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
        },
        {
            name: "弗吉尼亚普通 API",
            baseURL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
            protocol: chat,
            purpose: "ordinary",
            source: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
        },
    ]),
    adapter("glm", chat, "https://open.bigmodel.cn/api/paas/v4", null),
    adapter("mimo", chat, "https://api.xiaomimimo.com/v1", null),
    adapter("kimi", chat, "https://api.moonshot.ai/v1", "/models"),
    // AI SDK Anthropic appends /messages, unlike the Python SDK, which appends /v1/messages.
    adapter("minimax", messages, "https://api.minimax.io/anthropic/v1", null, [
        {
            name: "中国普通 API",
            baseURL: "https://api.minimaxi.com/anthropic/v1",
            protocol: messages,
            purpose: "ordinary",
            source: "https://platform.minimaxi.com/docs/api-reference/text-anthropic-api",
        },
    ]),
    adapter("deepseek", chat, "https://api.deepseek.com", "/models"),
    adapter("openai", responses, "https://api.openai.com/v1", "/models"),
    adapter("claude", messages, "https://api.anthropic.com/v1", "/models"),
    adapter("grok", responses, "https://api.x.ai/v1", "/models"),
];
const range = (min, max) => ({ min, max });
function preset(providerCode, modelId, maxOutputTokens, temperature, topP, thinking = false) {
    return {
        providerCode,
        modelId,
        name: modelId,
        maxOutputTokens,
        temperature,
        topP,
        thinking,
        budget: "final-and-reasoning",
        protocol: providerAdapters.find((x) => x.code === providerCode)
            .recommendedProtocol,
        source: sources[providerCode],
        checkedAt: "2026-09-17",
        recommended: true,
    };
}
export const modelPresets = [
    preset("qwen", "qwen-plus", 32768, { ...range(0, 2), exclusiveMax: true }, range(0, 1), true),
    preset("glm", "glm-5.2", 65536, { ...range(0, 1), decimals: 2 }, { ...range(0.01, 1), decimals: 2 }, true),
    preset("mimo", "mimo-v2.5-pro", 1024, range(1, 1), range(0.95, 0.95)),
    preset("kimi", "kimi-k3", 1024, null, null),
    preset("minimax", "MiniMax-M3", 1000, range(0, 2), range(0, 1)),
    preset("deepseek", "deepseek-flash", 384000, null, null, true),
    preset("openai", "gpt-5.4", 128000, null, null),
    preset("claude", "claude-sonnet-5", 128000, null, null),
    preset("grok", "grok-4.6", 1024, null, null),
];
