import { expect, it } from "vitest";
import { handleAiRequest } from "../examples/next/lib/http.js";
import type { AiHost, HostContext } from "../examples/next/lib/host.js";
import { createAiKit } from "ai-kit/server";
import { dependencies } from "./helpers.js";
const ctx: HostContext = {
  userId: "u",
  scope: "test",
  admin: true,
  allowedCodes: [],
  allowSystem: true,
  allowOverrides: true,
};
async function host(): Promise<AiHost> {
  const opts = dependencies();
  const kit = createAiKit<HostContext>({
    ...opts,
    rateLimit: async () => true,
    authorize: async (c, r) =>
      c.admin || ("code" in r && c.allowedCodes.includes(r.code)),
  });
  await kit.initializeDictionary(ctx);
  const conn = await kit.saveConnection(ctx, {
    name: "q",
    providerCode: "qwen",
    protocol: "openai-chat",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "env:AI_TEST",
    enabled: true,
  });
  await kit.savePlan(ctx, {
    code: "p",
    name: "p",
    connectionId: conn.id,
    modelId: "qwen-plus",
    enabled: true,
    isDefault: true,
  });
  return {
    kit,
    origin: "https://host.example",
    authenticate: async () => ctx,
    protectRequest: async () => {},
  };
}
function post(
  value: unknown,
  origin = "https://host.example",
  contentType = "application/json",
) {
  return new Request("https://host.example/api/ai-kit/generate", {
    method: "POST",
    headers: { origin, "content-type": contentType },
    body: JSON.stringify(value),
  });
}
it("enforces existing request protection, origin and admin authorization on server", async () => {
  const h = await host();
  expect(
    (
      await handleAiRequest(post({}), ["admin/dictionary-initialize"], {
        ...h,
        protectRequest: async () => {
          throw new Error("secret");
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await handleAiRequest(
        post({}, "https://evil.example"),
        ["admin/dictionary-initialize"],
        h,
      )
    ).status,
  ).toBe(403);
  const denied = { ...h, authenticate: async () => ({ ...ctx, admin: false }) };
  const response = await handleAiRequest(
    new Request("https://host.example"),
    ["admin", "connections"],
    denied,
  );
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("mock-secret");
});
it("rejects untrusted scope, model, signal, headers and oversized or non-JSON bodies", async () => {
  const h = await host(),
    input = { code: "p", messages: [{ role: "user", content: "hi" }] };
  for (const extra of [
    { tenantId: "evil" },
    { modelId: "x" },
    { signal: {} },
    { headers: { a: "b" } },
  ])
    expect(
      (await handleAiRequest(post({ ...input, ...extra }), ["generate"], h))
        .status,
    ).toBe(400);
  expect(
    (
      await handleAiRequest(
        post(input, "https://host.example", "application/jsonp"),
        ["generate"],
        h,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAiRequest(
        post({ messages: [{ role: "user", content: "x".repeat(66000) }] }),
        ["generate"],
        h,
      )
    ).status,
  ).toBe(400);
});
it("returns safe metadata and forbids response caching for successful calls", async () => {
  const h = await host(),
    response = await handleAiRequest(
      post({ code: "p", messages: [{ role: "user", content: "hi" }] }),
      ["generate"],
      h,
    );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    data: { code: "p", text: "OK", usage: null },
  });
});
it("reports a missing terminal stream event and relays HTTP cancellation", async () => {
  const h = await host();
  h.kit.stream = async function* () {
    yield { type: "text-delta", delta: "partial" };
  };
  const response = await handleAiRequest(
    post({ code: "p", messages: [{ role: "user", content: "hi" }] }),
    ["stream"],
    h,
  );
  expect(await response.text()).toContain("STREAM_INTERRUPTED");
  let signal: AbortSignal | undefined;
  h.kit.stream = async function* (c, i) {
    signal = i.signal;
    yield { type: "text-delta", delta: "partial" };
    await new Promise<void>((resolve) =>
      i.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  const cancelled = await handleAiRequest(
      post({ code: "p", messages: [{ role: "user", content: "hi" }] }),
      ["stream"],
      h,
    ),
    reader = cancelled.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(signal?.aborted).toBe(true);
});
