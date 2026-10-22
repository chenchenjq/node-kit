import { it, expect } from "vitest";
import { createAiKit } from "../src/server/index.js";
import { admin, dependencies } from "./helpers.js";
const connection = {
  name: "Qwen",
  providerCode: "qwen",
  protocol: "openai-chat" as const,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "env:AI_TEST",
  enabled: true,
};
async function setup() {
  const opts = dependencies(),
    kit = createAiKit(opts);
  await kit.initializeDictionary(admin);
  const c = await kit.saveConnection(admin, connection);
  return { opts, kit, c };
}
it("requires authorization for management, generation, query and tests", async () => {
  const { kit } = await setup(),
    ctx = { admin: false, allowed: [] };
  await expect(kit.listConnections(ctx)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    kit.testDraft(ctx, { connection, modelId: "qwen-plus" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    kit.generate(ctx, {
      code: "hidden",
      messages: [{ role: "user", content: "hi" }],
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await kit.listAuthorizedPlans(ctx)).toEqual([]);
});
it("does not return protected credentials and blank preserves key", async () => {
  const { kit, c, opts } = await setup();
  expect(JSON.stringify(c)).not.toMatch(/AI_TEST|mock-secret|envelope/i);
  const updated = await kit.saveConnection(admin, {
    ...connection,
    id: c.id,
    revision: c.revision,
    apiKey: "",
  });
  expect(updated.hasCredential).toBe(true);
  const stored = await opts.store.read((v) => v.getConnection(c.id));
  expect(stored?.credentialEnvelope).toBe("env:AI_TEST");
  await expect(
    kit.saveConnection(admin, {
      ...connection,
      id: c.id,
      revision: c.revision,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("retains exact hand-filled model ID but requires verified capabilities to call it", async () => {
  const { kit, c } = await setup();
  const p = await kit.savePlan(admin, {
    code: "custom",
    name: "Custom",
    connectionId: c.id,
    modelId: "My-Model-ID",
    enabled: true,
    isDefault: true,
  });
  expect(p.modelId).toBe("My-Model-ID");
  await expect(
    kit.generate(admin, {
      code: p.code,
      messages: [{ role: "user", content: "hi" }],
    }),
  ).rejects.toMatchObject({ code: "MODEL_CAPABILITIES_REQUIRED" });
});
it("supports many plans and serializes concurrent default selection", async () => {
  const { kit, c } = await setup();
  await Promise.all(
    ["one", "two"].map((code) =>
      kit.savePlan(admin, {
        code,
        name: code,
        connectionId: c.id,
        modelId: "qwen-plus",
        enabled: true,
        isDefault: true,
      }),
    ),
  );
  const plans = await kit.listPlans(admin);
  expect(plans).toHaveLength(2);
  expect(plans.filter((x) => x.isDefault)).toHaveLength(1);
  expect(
    await kit.listAuthorizedPlans({ admin: false, allowed: ["one"] }),
  ).toMatchObject([{ code: "one" }]);
  await expect(
    kit.deleteConnection(admin, c.id, c.revision),
  ).rejects.toMatchObject({ code: "CONNECTION_IN_USE" });
  await expect(
    kit.saveConnection(admin, {
      ...connection,
      id: c.id,
      revision: c.revision,
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: "DEFAULT_REQUIRES_ACTION" });
  await kit.saveConnection(admin, {
    ...connection,
    id: c.id,
    revision: c.revision,
    enabled: false,
    clearDefault: true,
  });
  expect((await kit.listPlans(admin)).some((p) => p.isDefault)).toBe(false);
});
it("rejects ordinary system prompts, overrides and arbitrary connection/model fields", async () => {
  const { kit, c } = await setup();
  await kit.savePlan(admin, {
    code: "one",
    name: "one",
    connectionId: c.id,
    modelId: "qwen-plus",
    enabled: true,
    isDefault: true,
  });
  const ctx = { admin: false, allowed: ["one"] };
  await expect(
    kit.generate(ctx, {
      code: "one",
      messages: [
        { role: "system", content: "unsafe" },
        { role: "user", content: "hi" },
      ],
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    kit.generate(ctx, {
      code: "one",
      options: { temperature: 1 },
      messages: [{ role: "user", content: "hi" }],
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    kit.generate(admin, {
      code: "one",
      messages: [{ role: "user", content: "hi" }],
      modelId: "evil",
    } as never),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
it("changing origin/provider requires explicit key-use confirmation even with a new key", async () => {
  const { kit, c } = await setup();
  await expect(
    kit.saveConnection(admin, {
      ...connection,
      id: c.id,
      revision: c.revision,
      baseURL: "https://other.example/v1",
    }),
  ).rejects.toMatchObject({ code: "KEY_DOMAIN_CONFIRMATION_REQUIRED" });
});
it("fails closed without host limiter or secret protection", () => {
  expect(() =>
    createAiKit({ ...dependencies(), rateLimit: undefined } as never),
  ).toThrow();
  expect(() =>
    createAiKit({ ...dependencies(), secrets: undefined } as never),
  ).toThrow();
});
