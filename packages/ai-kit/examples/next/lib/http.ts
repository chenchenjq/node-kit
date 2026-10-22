import { z } from "zod";
import { AiKitError } from "ai-kit/server";
import type {
  CallInput,
  ConnectionInput,
  PlanInput,
  StreamEvent,
  TestDraft,
} from "ai-kit";
import type { AiHost } from "./host";
const string = z.string().min(1).max(100);
function json(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(value, { ...init, headers });
}
async function body(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new AiKitError("INVALID_INPUT");
  if (Number(request.headers.get("content-length")) > 65536)
    throw new AiKitError("INVALID_INPUT");
  const reader = request.body?.getReader();
  if (!reader) throw new AiKitError("INVALID_INPUT");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) throw new AiKitError("INVALID_INPUT");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AiKitError("INVALID_INPUT");
  }
}
function strict<T>(schema: z.ZodType<T>, value: unknown): T {
  const p = schema.safeParse(value);
  if (!p.success) throw new AiKitError("INVALID_INPUT");
  return p.data;
}
export async function handleAiRequest(
  request: Request,
  path: string[],
  host: AiHost,
): Promise<Response> {
  try {
    const ctx = await host.authenticate(request);
    await host.protectRequest(request, ctx);
    if (
      request.method === "POST" &&
      request.headers.get("origin") !== host.origin
    )
      throw new AiKitError("FORBIDDEN");
    const key = path.join("/"),
      method = request.method;
    if (method === "GET") {
      if (key === "plans")
        return json({ data: await host.kit.listAuthorizedPlans(ctx) });
      if (key === "admin/connections")
        return json({ data: await host.kit.listConnections(ctx) });
      if (key === "admin/plans")
        return json({ data: await host.kit.listPlans(ctx) });
      if (key === "admin/providers")
        return json({ data: await host.kit.listProviders(ctx) });
    }
    if (method !== "POST")
      return json(
        { error: { code: "NOT_FOUND", message: "接口不存在" } },
        { status: 404 },
      );
    const value = await body(request);
    if (key === "admin/connections")
      return json({
        data: await host.kit.saveConnection(ctx, value as ConnectionInput),
      });
    if (key === "admin/plans")
      return json({ data: await host.kit.savePlan(ctx, value as PlanInput) });
    if (key === "admin/default") {
      const v = strict(z.strictObject({ code: string.nullable() }), value);
      await host.kit.setDefault(ctx, v.code);
      return json({ data: null });
    }
    if (key === "admin/dictionary-initialize") {
      strict(z.strictObject({}), value);
      await host.kit.initializeDictionary(ctx);
      return json({ data: null });
    }
    if (key === "admin/delete-connection") {
      const v = strict(
        z.strictObject({ id: string, revision: z.number().int().positive() }),
        value,
      );
      await host.kit.deleteConnection(ctx, v.id, v.revision);
      return json({ data: null });
    }
    if (key === "admin/test-plan") {
      const v = strict(z.strictObject({ code: string }), value);
      return json({
        data: await host.kit.testPlan(ctx, v.code, request.signal),
      });
    }
    if (key === "admin/test-draft")
      return json({
        data: await host.kit.testDraft(ctx, value as TestDraft, request.signal),
      });
    if (key === "admin/models") {
      const v = strict(z.strictObject({ connectionId: string }), value);
      return json({
        data: await host.kit.refreshModels(ctx, v.connectionId, request.signal),
      });
    }
    if (key === "generate" || key === "stream") {
      const object = strict(z.record(z.string(), z.unknown()), value);
      // Never let a browser supply an AbortSignal or context. Core validates every other field strictly.
      if ("signal" in object) throw new AiKitError("INVALID_INPUT");
      const input = {
        ...object,
        signal: request.signal,
      } as unknown as CallInput;
      if (key === "generate")
        return json({ data: await host.kit.generate(ctx, input) });
      const controller = new AbortController();
      const relay = () => controller.abort();
      request.signal.addEventListener("abort", relay, { once: true });
      if (request.signal.aborted) relay();
      const iterator = host.kit
        .stream(ctx, { ...input, signal: controller.signal })
        [Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      let finished = false;
      const cleanup = () => {
        request.signal.removeEventListener("abort", relay);
        controller.abort();
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const event = await iterator.next();
            if (event.done) {
              if (!finished)
                c.enqueue(
                  encoder.encode(
                    JSON.stringify({
                      type: "error",
                      error: {
                        code: "STREAM_INTERRUPTED",
                        message: "流中断，未取得最终状态",
                      },
                    } satisfies StreamEvent) + "\n",
                  ),
                );
              cleanup();
              c.close();
            } else {
              if (event.value.type === "finish" || event.value.type === "error")
                finished = true;
              c.enqueue(encoder.encode(JSON.stringify(event.value) + "\n"));
            }
          } catch {
            cleanup();
            c.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: "error",
                  error: { code: "NETWORK", message: "流请求失败" },
                } satisfies StreamEvent) + "\n",
              ),
            );
            c.close();
          }
        },
        async cancel() {
          cleanup();
          await iterator.return?.();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return json(
      { error: { code: "NOT_FOUND", message: "接口不存在" } },
      { status: 404 },
    );
  } catch (error) {
    const safe =
      error instanceof AiKitError ? error : new AiKitError("FORBIDDEN");
    return json(
      { error: safe.toJSON() },
      {
        status:
          safe.code === "FORBIDDEN"
            ? 403
            : safe.code === "RATE_LIMITED"
              ? 429
              : 400,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
