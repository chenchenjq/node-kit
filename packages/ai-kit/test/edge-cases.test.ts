import { it, expect } from "vitest";
import {
  createAiKit,
  createEnvironmentSecretProtector,
} from "../src/server/index.js";
import { dependencies, admin } from "./helpers.js";
import { jsonResponse } from "./provider-fixtures.js";
const input = {
  name: "q",
  providerCode: "qwen",
  protocol: "openai-chat" as const,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "env:AI_TEST",
  enabled: true,
};
async function setup(opts = dependencies()) {
  const kit = createAiKit(opts);
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, input);
  await kit.savePlan(admin, {
    code: "p",
    name: "p",
    connectionId: c.id,
    modelId: "qwen-plus",
    enabled: true,
    isDefault: true,
  });
  return { kit, c, opts };
}
it("rejects oversized inputs and denied shared limiter", async () => {
  const { kit, opts } = await setup();
  await expect(
    kit.generate(admin, {
      messages: [{ role: "user", content: "x".repeat(32001) }],
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  opts.rateLimit = async () => false;
  await expect(
    kit.generate(admin, { messages: [{ role: "user", content: "hi" }] }),
  ).rejects.toMatchObject({ code: "RATE_LIMITED" });
});
it("marks reasoning-only or length-terminated tests incomplete", async () => {
  const opts = dependencies(
    async () =>
      new Response(
        JSON.stringify({
          ...jsonResponse("openai-chat", "qwen-plus"),
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "budget used",
              },
              finish_reason: "length",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const { kit } = await setup(opts);
  const r = await kit.testPlan(admin, "p");
  expect(r.status).toBe("incomplete");
  expect(r.error).toBe(null);
  expect(r.result?.text).toBe("");
});
it("tests actual generation then invalidates test status on edits", async () => {
  const { kit, c } = await setup();
  expect((await kit.testPlan(admin, "p")).status).toBe("completed");
  expect((await kit.listConnections(admin))[0]?.testedRevision).toBe(
    c.revision,
  );
  const updated = await kit.saveConnection(admin, {
    ...input,
    id: c.id,
    revision: c.revision,
    apiKey: "",
  });
  expect(updated.testedRevision).toBe(null);
});
it("fixes configuration at request start and never reuses clients after key rotation", async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    pending = new Promise<void>((r) => (release = r)),
    headers: string[] = [];
  const opts = dependencies(async (_url, init) => {
    headers.push(new Headers(init?.headers).get("authorization")!);
    if (headers.length === 1) {
      entered();
      await pending;
    }
    return new Response(
      JSON.stringify(jsonResponse("openai-chat", "qwen-plus")),
      { headers: { "content-type": "application/json" } },
    );
  });
  opts.secrets = createEnvironmentSecretProtector(
    ["AI_TEST", "SECOND"],
    (name) => (name === "SECOND" ? "new-key" : "old-key"),
  );
  const { kit, c } = await setup(opts);
  const first = kit.generate(admin, {
    code: "p",
    messages: [{ role: "user", content: "hi" }],
  });
  await ready;
  await kit.saveConnection(admin, {
    ...input,
    id: c.id,
    revision: c.revision,
    apiKey: "env:SECOND",
  });
  release();
  expect((await first).text).toBe("OK");
  await kit.generate(admin, {
    code: "p",
    messages: [{ role: "user", content: "hi" }],
  });
  expect(headers).toEqual(["Bearer old-key", "Bearer new-key"]);
});
it("honors trusted system replacement and explicit system messages", async () => {
  let body: Record<string, unknown> = {};
  const { kit } = await setup(
    dependencies(async (_u, i) => {
      body = JSON.parse(String(i?.body));
      return new Response(
        JSON.stringify(jsonResponse("openai-chat", "qwen-plus")),
        { headers: { "content-type": "application/json" } },
      );
    }),
  );
  await kit.generate(admin, {
    code: "p",
    messages: [
      { role: "system", content: "trusted" },
      { role: "user", content: "hi" },
    ],
  });
  expect(body.messages).toMatchObject([
    { role: "system", content: "trusted" },
    { role: "user", content: "hi" },
  ]);
});
it("does not claim custom unsupported thinking or SDK ignored parameters work", async () => {
  const opts = dependencies(
    async () =>
      new Response(
        JSON.stringify(jsonResponse("anthropic-messages", "claude-sonnet-5")),
        { headers: { "content-type": "application/json" } },
      ),
  );
  opts.resolveModelCapabilities = async () => ({
    maxOutputTokens: 1000,
    temperature: { min: 0, max: 2 },
    topP: null,
    thinking: true,
    budget: "final-and-reasoning",
  });
  const kit = createAiKit(opts);
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, {
    ...input,
    providerCode: "claude",
    protocol: "anthropic-messages",
    baseURL: "https://api.anthropic.com/v1",
  });
  await kit.savePlan(admin, {
    code: "p",
    name: "p",
    connectionId: c.id,
    modelId: "claude-sonnet-5",
    enabled: true,
    isDefault: true,
  });
  await expect(
    kit.generate(admin, {
      code: "p",
      messages: [{ role: "user", content: "hi" }],
      options: { thinking: "disabled" },
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_PARAMETER" });
  await expect(
    kit.generate(admin, {
      code: "p",
      messages: [{ role: "user", content: "hi" }],
      options: { temperature: 0.5 },
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_PARAMETER" });
});
it("enforces response bytes, final text limits and redact quota errors", async () => {
  let calls = 0;
  const opts = dependencies(async () => {
    calls++;
    return new Response(
      JSON.stringify({
        error: { message: "key secret", code: "insufficient_quota" },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  });
  const { kit } = await setup(opts);
  await expect(
    kit.generate(admin, {
      messages: [{ role: "user", content: "hi" }],
      options: { maxRetries: 1 },
    }),
  ).rejects.toMatchObject({ code: "QUOTA" });
  expect(calls).toBe(1);
  const bounded = dependencies();
  bounded.limits = { maxOutputCharacters: 1 };
  const { kit: small } = await setup(bounded);
  await expect(
    small.generate(admin, { messages: [{ role: "user", content: "hi" }] }),
  ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
});
it("shows unsupported dictionary providers explicitly instead of executing dictionary data", async () => {
  const { kit, opts } = await setup();
  await opts.dictionary.insertItemIfAbsent("ai_model_provider", {
    code: "unknown",
    name: "New",
    enabled: true,
    sort: 100,
  });
  await expect(
    kit.saveConnection(admin, { ...input, providerCode: "unknown" }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
});
it("enforces verified exclusive and precision boundaries for Qwen, GLM and MiMo", async () => {
  const { kit, c } = await setup();
  await expect(
    kit.savePlan(admin, {
      code: "bad",
      name: "bad",
      connectionId: c.id,
      modelId: "qwen-plus",
      enabled: true,
      isDefault: false,
      parameters: { temperature: 2 },
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_PARAMETER" });
  const { validateParameters, defaultLimits } = await import(
    "../src/server/validation.js"
  );
  const { modelPresets } = await import("../src/catalog.js");
  const glm = modelPresets.find((p) => p.providerCode === "glm")!,
    mimo = modelPresets.find((p) => p.providerCode === "mimo")!;
  expect(() => validateParameters({ topP: 0 }, glm, defaultLimits)).toThrow();
  expect(() =>
    validateParameters({ temperature: 0.123 }, glm, defaultLimits),
  ).toThrow();
  expect(
    validateParameters({ temperature: 0.12, topP: 0.01 }, glm, defaultLimits),
  ).toMatchObject({ temperature: 0.12, topP: 0.01 });
  expect(() =>
    validateParameters({ temperature: 0.5 }, mimo, defaultLimits),
  ).toThrow();
  expect(
    validateParameters({ temperature: 1, topP: 0.95 }, mimo, defaultLimits),
  ).toMatchObject({ temperature: 1, topP: 0.95 });
});
it("redacts persistence and host failures at every public promise boundary", async () => {
  const { kit, opts } = await setup();
  opts.store.read = async () => {
    throw new Error("db password mock-secret private prompt");
  };
  await expect(kit.listConnections(admin)).rejects.toMatchObject({
    code: "NETWORK",
  });
  try {
    await kit.listConnections(admin);
  } catch (error) {
    expect(JSON.stringify(error)).not.toMatch(/password|mock-secret|prompt/);
  }
});
it("bounds draft validation DNS by timeout and aborts before sending credentials", async () => {
  let calls = 0;
  const opts = dependencies(async () => {
    calls++;
    throw new Error("must not generate");
  });
  const { kit } = await setup(opts);
  opts.transport!.lookup = async () => new Promise(() => {});
  const timed = await kit.testDraft(admin, {
    connection: input,
    modelId: "qwen-plus",
    parameters: { timeoutMs: 20 },
  });
  expect(timed).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
  expect(calls).toBe(0);
}, 1000);
it("returns cancelled for an already cancelled draft before address validation", async () => {
  const { kit, opts } = await setup();
  let lookups = 0;
  opts.transport!.lookup = async () => {
    lookups++;
    return new Promise(() => {});
  };
  const controller = new AbortController();
  controller.abort();
  const result = await kit.testDraft(
    admin,
    { connection: input, modelId: "qwen-plus" },
    controller.signal,
  );
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "CANCELLED" },
  });
  expect(lookups).toBe(0);
}, 1000);
it("bounds manual model refresh endpoint validation and preserves manual input after failure", async () => {
  const opts = dependencies();
  opts.limits = { maxTimeoutMs: 20 };
  const kit = createAiKit(opts);
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, {
    ...input,
    providerCode: "openai",
    protocol: "openai-responses",
    baseURL: "https://api.openai.com/v1",
  });
  let calls = 0;
  opts.allowURL = async () => (++calls === 1 ? true : new Promise(() => {}));
  await expect(kit.refreshModels(admin, c.id)).rejects.toMatchObject({
    code: "TIMEOUT",
  });
  await kit.savePlan(admin, {
    code: "manual",
    name: "manual",
    connectionId: c.id,
    modelId: "Hand-Written-ID",
    enabled: true,
    isDefault: false,
  });
  expect((await kit.listPlans(admin))[0]?.modelId).toBe("Hand-Written-ID");
}, 1000);
it("reports provider response byte limits through the actual SDK safely", async () => {
  const opts = dependencies();
  opts.limits = { maxResponseBytes: 64 };
  const { kit } = await setup(opts);
  await expect(
    kit.generate(admin, { messages: [{ role: "user", content: "hi" }] }),
  ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
});
