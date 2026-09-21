import { readJson, route } from "../../../lib/http";
import { asObject, asOptionalString, fail } from "../../../lib/protocol";
import { getHost } from "../../../lib/host";
import type { ParseOptions } from "addr-parse-kit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 收件原文一律走 POST 请求体，不进 URL：查询参数会进入访问日志、代理日志与浏览器历史。 */
function parseInput(value: unknown): { text: string; options: ParseOptions } {
  const body = asObject(value);
  for (const key of Object.keys(body)) if (!["text", "extractRecipient", "maxCandidates", "allowInferred", "regionHint"].includes(key)) {
    fail(`body 含未知字段 ${key}`);
  }
  if (typeof body.text !== "string") fail("body.text 必须是字符串");
  const options: ParseOptions = {};
  if (body.extractRecipient !== undefined) {
    if (typeof body.extractRecipient !== "boolean") fail("body.extractRecipient 必须是布尔值");
    options.extractRecipient = body.extractRecipient;
  }
  if (body.maxCandidates !== undefined) {
    if (!Number.isInteger(body.maxCandidates)) fail("body.maxCandidates 必须是整数");
    options.maxCandidates = body.maxCandidates as number;
  }
  if (body.allowInferred !== undefined) {
    if (typeof body.allowInferred !== "boolean") fail("body.allowInferred 必须是布尔值");
    options.allowInferred = body.allowInferred;
  }
  if (body.regionHint !== undefined) {
    const hint = asObject(body.regionHint, "body.regionHint");
    for (const key of Object.keys(hint)) if (!["provinceCode", "cityCode", "districtCode"].includes(key)) fail(`body.regionHint 含未知字段 ${key}`);
    const provinceCode = asOptionalString(hint.provinceCode, "body.regionHint.provinceCode", 24);
    const cityCode = asOptionalString(hint.cityCode, "body.regionHint.cityCode", 24);
    const districtCode = asOptionalString(hint.districtCode, "body.regionHint.districtCode", 24);
    options.regionHint = {
      ...(provinceCode === undefined ? {} : { provinceCode }),
      ...(cityCode === undefined ? {} : { cityCode }),
      ...(districtCode === undefined ? {} : { districtCode }),
    };
  }
  return { text: body.text, options };
}

export async function POST(request: Request): Promise<Response> {
  return route(request, "parse", async () => {
    const host = await getHost();
    const { text, options } = parseInput(await readJson(request));
    return Response.json({ data: host.parser.parse(text, options) }, { headers: { "cache-control": "no-store" } });
  });
}
