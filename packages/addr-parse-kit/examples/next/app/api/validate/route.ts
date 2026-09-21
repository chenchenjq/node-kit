import { readJson, route } from "../../../lib/http";
import { getHost, HostError } from "../../../lib/host";
import { asObject } from "../../../lib/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手工修正后的区域路径服务端复核（纯代码，不含收件信息）。 */
export async function POST(request: Request): Promise<Response> {
  return route(request, "validate", async () => {
    const host = await getHost();
    const body = asObject(await readJson(request));
    for (const key of Object.keys(body)) if (key !== "codes") throw new HostError(400, "E_HOST_INPUT", `body 含未知字段 ${key}`);
    if (!Array.isArray(body.codes) || body.codes.length > 5) throw new HostError(400, "E_HOST_INPUT", "body.codes 必须是不超过 5 项的数组");
    const codes = body.codes.map((item, index) => {
      if (item === null) return null;
      if (typeof item !== "string" || !item.length || item.length > 24) throw new HostError(400, "E_HOST_INPUT", `body.codes[${index}] 非法`);
      return item;
    });
    const structural = host.parser.validateSelection(codes);
    const path = await host.provider.validatePath(codes);
    const problems = [...structural.problems, ...path.problems.map((problem) => ({ code: problem.code, reason: `provider：${problem.reason}` }))];
    return Response.json({ data: { ok: problems.length === 0, problems } }, { headers: { "cache-control": "no-store" } });
  });
}
