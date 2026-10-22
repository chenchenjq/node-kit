import { Readable } from "node:stream";
import type { Credentials, StorageInput, StrategyInput } from "oss-kit";
import { errorInfo, OssKitError } from "oss-kit/server";
import type { StorageTestInput } from "oss-kit/server";
import { getOssHost } from "../../../../lib/host";
export const runtime = "nodejs";
type RouteContext = { params: Promise<{ path: string[] }> };
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
async function limitedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new OssKitError("INVALID_CONFIG");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32 * 1024) throw new OssKitError("INVALID_CONFIG"); chunks.push(next.value); }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OssKitError("INVALID_CONFIG");
    return parsed as Record<string, unknown>;
  } catch { throw new OssKitError("INVALID_CONFIG"); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function handler(request: Request, route: RouteContext) {
  try {
    const host = getOssHost(), ctx = await host.authenticate(request);
    if (!ctx.userId || ctx.scope !== host.scope) throw new OssKitError("FORBIDDEN");
    // Host owns CSRF/origin checks, rate limiting and request protection, including admin tests.
    await host.protectRequest(request, ctx);
    const { path } = await route.params;
    const admin = path[0] === "admin";
    if (admin && !ctx.admin) throw new OssKitError("FORBIDDEN");
    const action = path[admin ? 1 : 0];
    if (request.method === "GET" && action === "strategies") return json(await host.kit.listStrategies(ctx));
    if (admin && request.method === "GET" && action === "storage") return json(await host.kit.listStorage(ctx));
    if (admin && request.method === "POST") {
      const body = await limitedJson(request);
      if (action === "storage") return json(body.id ? await host.kit.updateStorage(ctx, String(body.id), body.input as StorageInput, body.credentials as Credentials | undefined) : await host.kit.createStorage(ctx, body.input as StorageInput, body.credentials as Credentials));
      if (action === "default") { await host.kit.setDefaultStorage(ctx, String(body.id)); return json({ ok: true }); }
      if (action === "enabled") { await host.kit.setStorageEnabled(ctx, String(body.id), body.enabled as boolean); return json({ ok: true }); }
      if (action === "test") return json(await host.kit.testStorage(ctx, body as unknown as StorageTestInput));
      if (action === "strategies") return json(await host.kit.saveStrategy(ctx, body as unknown as StrategyInput));
      if (action === "preview") return json({ objectKey: await host.kit.previewStrategy(ctx, body.input as StrategyInput, String(body.originalName)) });
    }
    if (!admin && request.method === "POST" && action === "upload") {
      if (!request.body) throw new OssKitError("INVALID_FILE");
      let originalName: string; try { originalName = decodeURIComponent(request.headers.get("x-oss-filename") ?? ""); } catch { throw new OssKitError("INVALID_FILE"); }
      // Native adapter forwards destroy/timeout to Web stream cancellation, even while read() is pending.
      const body = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);
      let reference;
      try {
        reference = await host.kit.upload(ctx, { strategyCode: request.headers.get("x-oss-strategy") ?? "", originalName, mimeType: request.headers.get("content-type") ?? "application/octet-stream", body });
      } finally { body.destroy(); }
      try { const fileId = await host.files.save(ctx.scope, ctx.userId, reference); return json({ fileId, reference }); }
      catch {
        // A failed host persistence leaves a successful OSS object. Report sanitized error; host must reconcile orphan objects.
        throw new OssKitError("STORE_ERROR");
      }
    }
    if (!admin && action === "files" && path[1]) {
      // Client supplies only a business ID. Fetch a trusted reference and check ownership before using the package.
      const file = await host.files.get(ctx.scope, path[1]);
      if (!file || (!ctx.admin && file.ownerId !== ctx.userId)) throw new OssKitError("FORBIDDEN");
      if (request.method === "GET" && path[2] === "link") return json(await host.kit.getAccessLink(ctx, file.reference));
      if (request.method === "GET" && path[2] === "read") {
        const stream = await host.kit.read(ctx, file.reference);
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: { "Content-Type": file.reference.mimeType, "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
      }
      if (request.method === "DELETE") { await host.kit.delete(ctx, file.reference); await host.files.remove(ctx.scope, file.id); return json({ ok: true }); }
    }
    throw new OssKitError("NOT_FOUND");
  } catch (error) {
    const info = error instanceof OssKitError ? errorInfo(error) : new OssKitError("FORBIDDEN").toJSON();
    return json({ error: info }, info.code === "FORBIDDEN" ? 403 : info.code === "NOT_FOUND" ? 404 : 400);
  }
}
export const GET = handler;
export const POST = handler;
export const DELETE = handler;
