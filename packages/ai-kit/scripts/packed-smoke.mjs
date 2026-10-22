import assert from "node:assert/strict";
import { createAiKit, createEnvironmentSecretProtector } from "ai-kit/server";
import { modelPresets, providerAdapters } from "ai-kit/catalog";
let connections = new Map(),
  plans = new Map(),
  tail = Promise.resolve();
function view(cs = connections, ps = plans) {
  return {
    getConnection: async (id) => structuredClone(cs.get(id) ?? null),
    listConnections: async () => structuredClone([...cs.values()]),
    saveConnection: async (c) => {
      cs.set(c.id, structuredClone(c));
    },
    deleteConnection: async (id) => {
      cs.delete(id);
    },
    getPlan: async (code) => structuredClone(ps.get(code) ?? null),
    listPlans: async () => structuredClone([...ps.values()]),
    savePlan: async (p) => {
      ps.set(p.code, structuredClone(p));
    },
  };
}
const store = {
  read: async (work) =>
    work(view(structuredClone(connections), structuredClone(plans))),
  transaction: async (work) => {
    const before = tail;
    let release;
    tail = new Promise((r) => (release = r));
    await before;
    const cs = structuredClone(connections),
      ps = structuredClone(plans);
    try {
      const result = await work(view(cs, ps));
      connections = cs;
      plans = ps;
      return result;
    } finally {
      release();
    }
  },
};
const items = new Map();
let streamMode = false;
const kit = createAiKit({
  scope: "packed-smoke",
  store,
  dictionary: {
    insertTypeIfAbsent: async () => {},
    insertItemIfAbsent: async (_t, item) => {
      if (!items.has(item.code)) items.set(item.code, item);
    },
    listItems: async () => [...items.values()],
  },
  secrets: createEnvironmentSecretProtector(["PACKED_MOCK"], () => "mock-key"),
  authorize: async (ctx) => ctx === true,
  rateLimit: async () => true,
  allowURL: async () => true,
  transport: {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)),
        model = body.model;
      let data;
      if (streamMode)
        return new Response(
          [
            {
              id: "s",
              object: "chat.completion.chunk",
              created: 1,
              model,
              choices: [
                { index: 0, delta: { content: "OK" }, finish_reason: null },
              ],
            },
            {
              id: "s",
              object: "chat.completion.chunk",
              created: 1,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]
            .map((x) => "data: " + JSON.stringify(x) + "\n\n")
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (String(url).endsWith("/messages"))
        data = {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 2 },
        };
      else if (String(url).endsWith("/responses"))
        data = {
          id: "resp_mock",
          object: "response",
          created_at: 1,
          model,
          status: "completed",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        };
      else
        data = {
          id: "r",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
        };
      return new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });
    },
  },
});
await kit.initializeDictionary(true);
await kit.initializeDictionary(true);
assert.equal((await kit.listProviders(true)).length, 9);
for (const p of modelPresets) {
  const a = providerAdapters.find((a) => a.code === p.providerCode),
    c = await kit.saveConnection(true, {
      name: a.code,
      providerCode: a.code,
      protocol: p.protocol,
      baseURL: a.endpoints[0].baseURL,
      apiKey: "env:PACKED_MOCK",
      enabled: true,
    });
  assert(!JSON.stringify(c).includes("PACKED_MOCK"));
  await kit.savePlan(true, {
    code: a.code,
    name: a.code,
    connectionId: c.id,
    modelId: p.modelId,
    enabled: true,
    isDefault: true,
  });
  assert.equal(
    (
      await kit.generate(true, {
        code: a.code,
        messages: [{ role: "user", content: "hi" }],
      })
    ).text,
    "OK",
  );
}
assert.equal((await kit.listPlans(true)).filter((p) => p.isDefault).length, 1);
streamMode = true;
const events = [];
for await (const e of kit.stream(true, {
  code: "qwen",
  messages: [{ role: "user", content: "hi" }],
}))
  events.push(e);
assert.equal(events.at(-1).type, "finish");
assert.equal(events.at(-1).result.usage, null);
await assert.rejects(
  kit.generate(false, {
    code: "qwen",
    messages: [{ role: "user", content: "hi" }],
  }),
  (e) => e.code === "FORBIDDEN",
);
console.log(
  "Installed tgz: nine Mock providers, management, stream, null usage, authorization PASS",
);
