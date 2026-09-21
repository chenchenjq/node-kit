import { auditLine, authenticate, errorToHostError, getHost, HostError, rateLimit } from "./host";

const MAX_BODY_BYTES = 32_768;

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "cache-control": "no-store" } });
}

export function errorResponse(error: unknown): Response {
  const hostError = errorToHostError(error);
  return Response.json(
    { error: { code: hostError.code, message: hostError.message } },
    { status: hostError.status, headers: { "cache-control": "no-store" } },
  );
}

/** 读取真实请求流，伪造 Content-Length 绕不过大小上限。 */
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !== "application/json") {
    throw new HostError(400, "E_CONTENT_TYPE", "请求体必须是 application/json");
  }
  if (!request.body) throw new HostError(400, "E_BODY_EMPTY", "请求体为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new HostError(413, "E_BODY_TOO_LARGE", "请求体超出上限");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks, size));
  } catch {
    throw new HostError(400, "E_ENCODING", "请求体必须是 UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HostError(400, "E_JSON", "请求体不是合法 JSON");
  }
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** 所有路由的统一入口：认证 → 限流 → 处理 → 错误映射 → 无 PII 审计日志。 */
export async function route(request: Request, path: string, handler: () => Promise<Response>): Promise<Response> {
  let status = 500;
  try {
    const session = await authenticate(request);
    rateLimit(`${session}:${path}`);
    const response = await handler();
    status = response.status;
    return response;
  } catch (error) {
    const response = errorResponse(error);
    status = response.status;
    return response;
  } finally {
    console.log(auditLine({ route: path, status }));
  }
}

export { getHost };
