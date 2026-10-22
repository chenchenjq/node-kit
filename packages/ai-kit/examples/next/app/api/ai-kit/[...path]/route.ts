import { getAiHost } from "../../../../lib/host";
import { handleAiRequest } from "../../../../lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handler(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  return handleAiRequest(request, (await ctx.params).path, getAiHost());
}
export { handler as GET, handler as POST };
