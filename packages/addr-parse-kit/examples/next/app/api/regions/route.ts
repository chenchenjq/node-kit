import { route } from "../../../lib/http";
import { getHost, HostError } from "../../../lib/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 手工修正用的区域下钻列表。查询参数只有区域代码，不含任何收件信息。 */
export async function GET(request: Request): Promise<Response> {
  return route(request, "regions", async () => {
    const host = await getHost();
    const params = new URL(request.url).searchParams;
    for (const key of new Set(params.keys())) if (key !== "parentCode") throw new HostError(400, "E_QUERY", "不支持的查询参数");
    const raw = params.get("parentCode") ?? "";
    if (raw.length > 24) throw new HostError(400, "E_QUERY", "parentCode 非法");
    const parentCode = raw.length === 0 ? null : raw;
    const items = host.provider.childrenOf(parentCode).map((node) => ({
      code: node.code,
      name: node.name,
      level: node.level,
      kind: node.kind,
    }));
    return Response.json({ data: { parentCode, items } }, { headers: { "cache-control": "no-store" } });
  });
}
