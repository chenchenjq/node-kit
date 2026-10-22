import { it, expect } from "vitest";
import { createAiKit } from "../src/server/index.js";
import { modelPresets, providerAdapters } from "../src/catalog.js";
import { admin, dependencies } from "./helpers.js";
import { jsonResponse } from "./provider-fixtures.js";
it.each(modelPresets)(
  "$providerCode uses real SDK and its exact URL/token/header contract",
  async (preset) => {
    let target = "",
      body: Record<string, unknown> = {},
      headers = new Headers();
    const opts = dependencies(async (url, init) => {
      target = String(url);
      body = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify(jsonResponse(preset.protocol, preset.modelId)),
        {
          headers: {
            "content-type": "application/json",
            "x-request-id": "mock-request",
          },
        },
      );
    });
    const kit = createAiKit(opts);
    await kit.initializeDictionary(admin);
    const a = providerAdapters.find((a) => a.code === preset.providerCode)!;
    const c = await kit.saveConnection(admin, {
      name: "test",
      providerCode: a.code,
      protocol: preset.protocol,
      baseURL: a.endpoints[0]!.baseURL,
      apiKey: "env:AI_TEST",
      enabled: true,
    });
    await kit.savePlan(admin, {
      code: "plan",
      name: "plan",
      connectionId: c.id,
      modelId: preset.modelId,
      enabled: true,
      isDefault: true,
    });
    const result = await kit.generate(admin, {
      messages: [{ role: "user", content: "hi" }],
    });
    const suffix =
      preset.protocol === "openai-chat"
        ? "/chat/completions"
        : preset.protocol === "anthropic-messages"
          ? "/messages"
          : "/responses";
    expect(target).toBe(a.endpoints[0]!.baseURL + suffix);
    expect(body.model).toBe(preset.modelId);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(
      body[
        preset.protocol === "openai-responses"
          ? "max_output_tokens"
          : preset.providerCode === "mimo"
            ? "max_completion_tokens"
            : "max_tokens"
      ],
    ).toBe(Math.min(1024, preset.maxOutputTokens));
    expect(
      headers.get(
        preset.providerCode === "mimo"
          ? "api-key"
          : preset.protocol === "anthropic-messages"
            ? "x-api-key"
            : "authorization",
      ),
    ).toBe(
      preset.protocol === "anthropic-messages" || preset.providerCode === "mimo"
        ? "mock-secret"
        : "Bearer mock-secret",
    );
    if (preset.providerCode === "openai") expect(body.store).toBe(false);
    expect(result).toMatchObject({
      text: "OK",
      code: "plan",
      modelId: preset.modelId,
      status: "completed",
    });
    expect(result.reasoning).toContain("separate");
    expect(result.usage?.inputTokens).toBe(5);
  },
);
it("unknown usage stays null and output is never counted as zero", async () => {
  const kit = createAiKit(dependencies());
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, {
    name: "q",
    providerCode: "qwen",
    protocol: "openai-chat",
    baseURL: providerAdapters[0]!.endpoints[0]!.baseURL,
    apiKey: "env:AI_TEST",
    enabled: true,
  });
  await kit.savePlan(admin, {
    code: "p",
    name: "p",
    connectionId: c.id,
    modelId: "qwen-plus",
    enabled: true,
    isDefault: true,
  });
  expect(
    (await kit.generate(admin, { messages: [{ role: "user", content: "hi" }] }))
      .usage,
  ).toBe(null);
});
it("rejects unsupported explicit parameters and maps verified thinking only", async () => {
  let body: Record<string, unknown> = {};
  const kit = createAiKit(
    dependencies(async (_u, i) => {
      body = JSON.parse(String(i?.body));
      return new Response(
        JSON.stringify(jsonResponse("openai-chat", "deepseek-flash")),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, {
    name: "d",
    providerCode: "deepseek",
    protocol: "openai-chat",
    baseURL: "https://api.deepseek.com",
    apiKey: "env:AI_TEST",
    enabled: true,
  });
  await expect(
    kit.savePlan(admin, {
      code: "bad",
      name: "bad",
      connectionId: c.id,
      modelId: "deepseek-flash",
      enabled: true,
      isDefault: false,
      parameters: { temperature: 0.2 },
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_PARAMETER" });
  await kit.savePlan(admin, {
    code: "p",
    name: "p",
    connectionId: c.id,
    modelId: "deepseek-flash",
    enabled: true,
    isDefault: true,
    parameters: { thinking: "disabled" },
  });
  await kit.generate(admin, { messages: [{ role: "user", content: "hi" }] });
  expect(body.thinking).toEqual({ type: "disabled" });
});
it("partial provider usage does not fabricate zero reasoning or input tokens", async () => {
  const opts = dependencies(
    async () =>
      new Response(
        JSON.stringify({
          ...jsonResponse("openai-chat", "qwen-plus"),
          usage: { completion_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const kit = createAiKit(opts);
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, {
    name: "q",
    providerCode: "qwen",
    protocol: "openai-chat",
    baseURL: providerAdapters[0]!.endpoints[0]!.baseURL,
    apiKey: "env:AI_TEST",
    enabled: true,
  });
  await kit.savePlan(admin, {
    code: "p",
    name: "p",
    connectionId: c.id,
    modelId: "qwen-plus",
    enabled: true,
    isDefault: true,
  });
  expect(
    (await kit.generate(admin, { messages: [{ role: "user", content: "hi" }] }))
      .usage,
  ).toEqual({
    inputTokens: null,
    outputTokens: 3,
    totalTokens: null,
    reasoningTokens: null,
  });
});
it("keeps native OpenAI Chat distinct from Responses and compatible Chat token fields", async () => {
  let body: Record<string, unknown> = {},
    url = "";
  const opts = dependencies(async (u, i) => {
    url = String(u);
    body = JSON.parse(String(i?.body));
    return new Response(
      JSON.stringify(jsonResponse("openai-chat", "gpt-5.4")),
      { headers: { "content-type": "application/json" } },
    );
  });
  const kit = createAiKit(opts);
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, {
    name: "chat",
    providerCode: "openai",
    protocol: "openai-chat",
    baseURL: "https://api.openai.com/v1",
    apiKey: "env:AI_TEST",
    enabled: true,
  });
  await kit.savePlan(admin, {
    code: "chat",
    name: "chat",
    connectionId: c.id,
    modelId: "gpt-5.4",
    enabled: true,
    isDefault: true,
  });
  expect(
    (await kit.generate(admin, { messages: [{ role: "user", content: "hi" }] }))
      .text,
  ).toBe("OK");
  expect(url).toBe("https://api.openai.com/v1/chat/completions");
  expect(body).toMatchObject({ max_completion_tokens: 1024, store: false });
  expect(body.max_tokens).toBeUndefined();
});
it.each(["claude", "minimax"])(
  "preserves $0 Messages thinking_tokens and never invents absent counts",
  async (providerCode) => {
    const preset = modelPresets.find((p) => p.providerCode === providerCode)!,
      a = providerAdapters.find((a) => a.code === providerCode)!;
    for (const count of [1, 0, undefined]) {
      const kit = createAiKit(
        dependencies(
          async () =>
            new Response(
              JSON.stringify({
                ...jsonResponse("anthropic-messages", preset.modelId),
                usage: {
                  input_tokens: 5,
                  output_tokens: 3,
                  ...(count !== undefined
                    ? { output_tokens_details: { thinking_tokens: count } }
                    : {}),
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      );
      await kit.initializeDictionary(admin);
      const c = await kit.saveConnection(admin, {
        name: "test",
        providerCode,
        protocol: "anthropic-messages",
        baseURL: a.endpoints[0]!.baseURL,
        apiKey: "env:AI_TEST",
        enabled: true,
      });
      await kit.savePlan(admin, {
        code: "p",
        name: "p",
        connectionId: c.id,
        modelId: preset.modelId,
        enabled: true,
        isDefault: true,
      });
      const r = await kit.generate(admin, {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r.usage).toMatchObject({
        inputTokens: 5,
        outputTokens: 3,
        reasoningTokens: count ?? null,
      });
    }
  },
);
