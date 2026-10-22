import { it, expect } from "vitest";
import { createAiKit } from "../src/server/index.js";
import { providerAdapters, modelPresets } from "../src/catalog.js";
import { admin, dependencies } from "./helpers.js";
import { jsonResponse } from "./provider-fixtures.js";
import type { StreamEvent } from "../src/types.js";
function sse(events: unknown[], named = false) {
  return new Response(
    events
      .map(
        (e) =>
          `${named ? "event: " + (e as { type: string }).type + "\n" : ""}data: ${JSON.stringify(e)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
export function streamFixture(protocol: string, modelId: string) {
  if (protocol === "anthropic-messages")
    return sse(
      [
        {
          type: "message_start",
          message: {
            id: "msg_stream",
            type: "message",
            role: "assistant",
            model: modelId,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "OK" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ],
      true,
    );
  if (protocol === "openai-responses")
    return sse(
      [
        {
          type: "response.created",
          response: { id: "resp_stream", created_at: 1, model: modelId },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_stream",
            role: "assistant",
            content: [],
            status: "in_progress",
          },
        },
        {
          type: "response.content_part.added",
          item_id: "msg_stream",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_stream",
          output_index: 0,
          content_index: 0,
          delta: "OK",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_stream",
            role: "assistant",
            content: [{ type: "output_text", text: "OK", annotations: [] }],
            status: "completed",
          },
        },
        {
          type: "response.completed",
          response: jsonResponse(protocol, modelId),
        },
      ],
      true,
    );
  return sse([
    {
      id: "chat_stream",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "OK",
            reasoning_content: "separate",
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chat_stream",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    },
  ]);
}
async function setup(
  fetch: typeof globalThis.fetch,
  providerCode = "qwen",
  parameters = {},
) {
  const opts = dependencies(fetch),
    kit = createAiKit(opts);
  await kit.initializeDictionary(admin);
  const a = providerAdapters.find((a) => a.code === providerCode)!,
    p = modelPresets.find((p) => p.providerCode === providerCode)!;
  const c = await kit.saveConnection(admin, {
    name: "c",
    providerCode,
    protocol: a.recommendedProtocol,
    baseURL: a.endpoints[0]!.baseURL,
    apiKey: "env:AI_TEST",
    enabled: true,
  });
  await kit.savePlan(admin, {
    code: "p",
    name: "p",
    connectionId: c.id,
    modelId: p.modelId,
    enabled: true,
    isDefault: true,
    parameters,
  });
  return { kit, opts, c };
}
it.each(modelPresets)(
  "$providerCode streams incremental text and final state using actual SDK parser",
  async (p) => {
    const { kit } = await setup(
      async () => streamFixture(p.protocol, p.modelId),
      p.providerCode,
    );
    const events = [];
    for await (const event of kit.stream(admin, {
      messages: [{ role: "user", content: "hi" }],
    }))
      events.push(event);
    expect(events).toContainEqual({ type: "text-delta", delta: "OK" });
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      result: { text: "OK", status: "completed" },
    });
  },
);
it("reports interruption after partial output and does not replay", async () => {
  let calls = 0;
  const { kit } = await setup(async () => {
    calls++;
    return sse([
      {
        id: "s",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen-plus",
        choices: [
          { index: 0, delta: { content: "partial" }, finish_reason: null },
        ],
      },
    ]);
  });
  const events: StreamEvent[] = [];
  for await (const e of kit.stream(admin, {
    messages: [{ role: "user", content: "hi" }],
  }))
    events.push(e);
  expect(events[0]).toMatchObject({ type: "text-delta", delta: "partial" });
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: { code: "STREAM_INTERRUPTED" },
  });
  expect(calls).toBe(1);
});
it("turns in-stream provider errors into a safe terminal event", async () => {
  const { kit } = await setup(async () =>
    sse([{ error: { message: "secret", code: "bad" } }]),
  );
  const events = [];
  for await (const e of kit.stream(admin, {
    messages: [{ role: "user", content: "hi" }],
  }))
    events.push(e);
  expect(events.at(-1)?.type).toBe("error");
  expect(JSON.stringify(events)).not.toContain("secret");
});
it("handles pre-aborted calls and returns cancelled stream status", async () => {
  const { kit } = await setup(async () =>
    streamFixture("openai-chat", "qwen-plus"),
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    kit.generate(admin, {
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  const events = [];
  for await (const e of kit.stream(admin, {
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
  }))
    events.push(e);
  expect(events).toEqual([
    { type: "error", error: { code: "CANCELLED", message: "请求已取消" } },
  ]);
});
it("cancels a running stream and closes the provider body", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const { kit } = await setup(
    async (_u, i) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                "data: " +
                  JSON.stringify({
                    id: "s",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "qwen-plus",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "first" },
                        finish_reason: null,
                      },
                    ],
                  }) +
                  "\n\n",
              ),
            );
            i?.signal?.addEventListener(
              "abort",
              () => c.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const events = [];
  for await (const e of kit.stream(admin, {
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
  })) {
    events.push(e);
    if (e.type === "text-delta") controller.abort();
  }
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: { code: "CANCELLED" },
  });
});
it("bounds timeout and does not retry unknown request results", async () => {
  let calls = 0;
  const { kit } = await setup(
    async (_u, i) => {
      calls++;
      return new Promise((_r, reject) =>
        i?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        ),
      );
    },
    "qwen",
    { timeoutMs: 20, maxRetries: 1 },
  );
  await expect(
    kit.generate(admin, { messages: [{ role: "user", content: "hi" }] }),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(calls).toBe(1);
});
it("only retries explicitly rejected rate limits, never quota", async () => {
  let calls = 0;
  const { kit } = await setup(
    async () => {
      calls++;
      return calls === 1
        ? new Response(
            JSON.stringify({
              error: { message: "rate", code: "rate_limit_exceeded" },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          )
        : new Response(
            JSON.stringify(jsonResponse("openai-chat", "qwen-plus")),
            { headers: { "content-type": "application/json" } },
          );
    },
    "qwen",
    { maxRetries: 1 },
  );
  expect(
    (await kit.generate(admin, { messages: [{ role: "user", content: "hi" }] }))
      .text,
  ).toBe("OK");
  expect(calls).toBe(2);
});
it("cancels the provider reader on early break without provider cooperation", async () => {
  let cancelled = false;
  const { kit } = await setup(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                "data: " +
                  JSON.stringify({
                    id: "s",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "qwen-plus",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "first" },
                        finish_reason: null,
                      },
                    ],
                  }) +
                  "\n\n",
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  for await (const event of kit.stream(admin, {
    messages: [{ role: "user", content: "hi" }],
  })) {
    if (event.type === "text-delta") break;
  }
  expect(cancelled).toBe(true);
});
it("times out while the final target whitelist is pending without replay", async () => {
  let fetches = 0;
  const { kit, opts } = await setup(
    async () => {
      fetches++;
      return streamFixture("openai-chat", "qwen-plus");
    },
    "qwen",
    { timeoutMs: 20 },
  );
  let checks = 0;
  opts.allowURL = async () => (++checks === 1 ? true : new Promise(() => {}));
  const events = [];
  for await (const e of kit.stream(admin, {
    messages: [{ role: "user", content: "hi" }],
  }))
    events.push(e);
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: { code: "TIMEOUT" },
  });
  expect(fetches).toBe(0);
}, 1000);
it("preserves Messages stream final thinking_tokens separately from output tokens", async () => {
  const { kit } = await setup(
    async () =>
      sse(
        [
          {
            type: "message_start",
            message: {
              id: "m",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "OK" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: {
              output_tokens: 3,
              output_tokens_details: { thinking_tokens: 1 },
            },
          },
          { type: "message_stop" },
        ],
        true,
      ),
    "claude",
  );
  const events = [];
  for await (const e of kit.stream(admin, {
    messages: [{ role: "user", content: "hi" }],
  }))
    events.push(e);
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    result: { usage: { inputTokens: 5, outputTokens: 3, reasoningTokens: 1 } },
  });
});
