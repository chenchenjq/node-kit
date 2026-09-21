import { AreaKitError } from "area-kit/server";
import { getAreaHost } from "../../../lib/host.js";
import { areaError, areaJson, parseValidationInput, readAreaJsonBody, requireAreaJson } from "../../../lib/http.js";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  try {
    if (request.method !== "POST" || new URL(request.url).searchParams.size) throw new AreaKitError("INVALID_ARGUMENT");
    requireAreaJson(request);
    const input = parseValidationInput(await readAreaJsonBody(request));
    return areaJson(await getAreaHost().submit(request, input));
  } catch (error) { return areaError(error); }
}
