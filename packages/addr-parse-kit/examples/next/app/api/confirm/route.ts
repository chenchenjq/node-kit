import { readJson, route } from "../../../lib/http";
import { confirmAddress, getHost } from "../../../lib/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 用户点击“确认”之后才会走到这里：解析结果本身从不自动落库。 */
export async function POST(request: Request): Promise<Response> {
  return route(request, "confirm", async () => {
    const host = await getHost();
    const { record } = await confirmAddress(host, await readJson(request));
    // 示例直接回显整条记录便于观察；生产宿主只回 id，由宿主自己的权限模型再读取。
    return Response.json({ data: record }, { headers: { "cache-control": "no-store" } });
  });
}
