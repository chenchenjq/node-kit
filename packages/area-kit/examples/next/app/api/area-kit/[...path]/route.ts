import { getAreaHost } from "../../../../lib/host.js";
import { areaError, handleAreaRequest } from "../../../../lib/http.js";

export const runtime = "nodejs";
async function handle(request: Request, context: {params: Promise<{path: string[]}>}): Promise<Response> {
  try { return await handleAreaRequest(request, (await context.params).path, getAreaHost()); }
  catch (error) { return areaError(error); }
}
export { handle as GET, handle as POST, handle as PATCH };
