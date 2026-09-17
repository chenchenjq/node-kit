import { AreaKitError, sanitizeError, type AreaKit, type AreaKitOptions } from "area-kit/server";
import type { Level, PresentationInput, SelectionPolicy, ValidationInput, VersionPolicy } from "area-kit";

export interface AreaHost<C> {
  kit: AreaKit<C>;
  authorize: AreaKitOptions<C>["authorize"];
  authenticate(request: Request): Promise<C>;
  protectRequest(request: Request, ctx: C): Promise<void>;
  previewPolicy(ctx: C, targetLevel: Level): SelectionPolicy;
  submissionPolicy(ctx: C): {targetLevel: Level; policy: SelectionPolicy; versionPolicy: VersionPolicy};
  origin: string;
}

const MAX_BODY_BYTES = 65_536;
const levels = new Set<Level>([1, 2, 3, 4, 5]);
const int32Min = -(2 ** 31), int32Max = 2 ** 31 - 1;

function invalid(): never { throw new AreaKitError("INVALID_ARGUMENT"); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function code(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length) invalid();
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid();
}
function queryValue(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) invalid();
  return values[0];
}
function stringQuery(params: URLSearchParams, name: string, required = false): string | undefined {
  const value = queryValue(params, name);
  if (value === undefined) { if (required) invalid(); return undefined; }
  code(value);
  return value;
}
/** Empty parentCode is reserved for null; codes themselves must be nonempty. */
function nullableCodeQuery(params: URLSearchParams, name: string): string | null | undefined {
  const value = queryValue(params, name);
  if (value === undefined) return undefined;
  if (!value.length) return null;
  code(value);
  return value;
}
function intQuery(params: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const value = queryValue(params, name);
  if (value === undefined || !/^-?\d+$/.test(value)) return value === undefined ? undefined : invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) invalid();
  return result;
}
function booleanQuery(params: URLSearchParams, name: string): boolean | undefined {
  const value = queryValue(params, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return invalid();
}
function validateQuery(params: URLSearchParams, allowed: readonly string[]): void {
  for (const name of new Set(params.keys())) if (!allowed.includes(name)) invalid();
}
function selector(params: URLSearchParams): {datasetId?: string; versionCode?: string} {
  const datasetId = stringQuery(params, "datasetId"), versionCode = stringQuery(params, "versionCode");
  return {...(datasetId === undefined ? {} : {datasetId}), ...(versionCode === undefined ? {} : {versionCode})};
}
function page(params: URLSearchParams): {limit?: number; cursor?: string} {
  const limit = intQuery(params, "limit", 1, 200), cursor = stringQuery(params, "cursor");
  return {...(limit === undefined ? {} : {limit}), ...(cursor === undefined ? {} : {cursor})};
}
function levelQuery(params: URLSearchParams, name: string): Level | undefined {
  const value = intQuery(params, name, 1, 5);
  if (value === undefined) return undefined;
  if (!levels.has(value as Level)) invalid();
  return value as Level;
}
export function requireAreaJson(request: Request): void {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !== "application/json") invalid();
}
export function areaJson(data: unknown, status = 200): Response {
  return Response.json({data}, {status, headers: {"cache-control": "no-store"}});
}
export function areaError(error: unknown): Response {
  const safe = sanitizeError(error);
  const statuses: Partial<Record<AreaKitError["code"], number>> = {
    FORBIDDEN: 403, UNKNOWN_CODE: 404, VERSION_UNAVAILABLE: 404, REVISION_CONFLICT: 409, IMPORT_CONFLICT: 409,
    INVALID_ARGUMENT: 400, QUERY_LIMIT_EXCEEDED: 400, TARGET_LEVEL_NOT_REACHED: 422, PARENT_MISMATCH: 422, NOT_SELECTABLE: 422, NOT_INITIALIZED: 503, QUERY_FAILED: 500,
  };
  return Response.json({error: safe.toJSON()}, {status: statuses[safe.code] ?? 500, headers: {"cache-control": "no-store"}});
}

/** Reads the actual request stream so a forged Content-Length cannot bypass the body limit. */
export async function readAreaJsonBody(request: Request): Promise<unknown> {
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) invalid();
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(concat(chunks, size))); }
  catch (cause) { if (cause instanceof AreaKitError) throw cause; invalid(); }
}
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export function parseValidationInput(value: unknown): ValidationInput {
  object(value); keys(value, ["datasetId", "versionCode", "pathCodes", "targetLevel"]);
  if (!Array.isArray(value.pathCodes) || value.pathCodes.length < 1 || value.pathCodes.length > 5) invalid();
  value.pathCodes.forEach(code);
  if (value.datasetId !== undefined) code(value.datasetId);
  if (value.versionCode !== undefined) code(value.versionCode);
  if (value.targetLevel !== undefined && (!Number.isInteger(value.targetLevel) || !levels.has(value.targetLevel as Level))) invalid();
  return {...(value.datasetId === undefined ? {} : {datasetId: value.datasetId}), ...(value.versionCode === undefined ? {} : {versionCode: value.versionCode}),
    pathCodes: value.pathCodes, ...(value.targetLevel === undefined ? {} : {targetLevel: value.targetLevel as Level})};
}
function presentationInput(value: unknown): PresentationInput {
  object(value); keys(value, ["datasetId", "versionCode", "code", "revision", "patch"]);
  code(value.code); integer(value.revision, 1, int32Max); object(value.patch);
  keys(value.patch, ["displayName", "sort", "enabled"]);
  if (!Object.keys(value.patch).length) invalid();
  if (value.patch.displayName !== undefined && value.patch.displayName !== null && typeof value.patch.displayName !== "string") invalid();
  if (value.patch.sort !== undefined) integer(value.patch.sort, int32Min, int32Max);
  if (value.patch.enabled !== undefined && typeof value.patch.enabled !== "boolean") invalid();
  if (value.datasetId !== undefined) code(value.datasetId);
  if (value.versionCode !== undefined) code(value.versionCode);
  const patch: PresentationInput["patch"] = {};
  if (value.patch.displayName !== undefined) patch.displayName = value.patch.displayName as string | null;
  if (value.patch.sort !== undefined) patch.sort = value.patch.sort as number;
  if (value.patch.enabled !== undefined) patch.enabled = value.patch.enabled as boolean;
  return {...(value.datasetId === undefined ? {} : {datasetId: value.datasetId}), ...(value.versionCode === undefined ? {} : {versionCode: value.versionCode}),
    code: value.code, revision: value.revision, patch};
}

export async function handleAreaRequest<C>(request: Request, path: readonly string[], host: AreaHost<C>): Promise<Response> {
  try {
    const route = path.join("/");
    const methods: Record<string, string> = {dataset: "GET", datasets: "GET", provinces: "GET", children: "GET", regions: "GET", region: "GET", batch: "GET", path: "GET", search: "GET", tree: "GET", validate: "POST", "admin/presentation": "PATCH", "admin/report": "GET"};
    if (methods[route] !== request.method) invalid();
    if (route === "admin/presentation" && request.headers.get("origin") !== host.origin) throw new AreaKitError("FORBIDDEN");
    const ctx = await host.authenticate(request);
    await host.protectRequest(request, ctx);
    const params = new URL(request.url).searchParams;
    if (route === "dataset") { validateQuery(params, ["datasetId", "versionCode"]); return areaJson(await host.kit.getDataset(ctx, selector(params))); }
    if (route === "datasets") {
      validateQuery(params, ["limit", "cursor", "includeUnavailable"]); const includeUnavailable = booleanQuery(params, "includeUnavailable");
      return areaJson(await host.kit.listDatasets(ctx, {...page(params), ...(includeUnavailable === undefined ? {} : {includeUnavailable})}));
    }
    if (route === "provinces") { validateQuery(params, ["datasetId", "versionCode", "limit", "cursor"]); return areaJson(await host.kit.listProvinces(ctx, {...selector(params), ...page(params)})); }
    if (route === "children") {
      validateQuery(params, ["datasetId", "versionCode", "limit", "cursor", "parentCode", "ancestorCode", "level", "selectableOnly"]);
      const ancestorCode = stringQuery(params, "ancestorCode"), level = levelQuery(params, "level"), selectableOnly = booleanQuery(params, "selectableOnly");
      return areaJson(await host.kit.listChildren(ctx, {...selector(params), ...page(params), parentCode: stringQuery(params, "parentCode", true)!, ...(ancestorCode === undefined ? {} : {ancestorCode}), ...(level === undefined ? {} : {level}), ...(selectableOnly === undefined ? {} : {selectableOnly})}));
    }
    if (route === "regions") {
      validateQuery(params, ["datasetId", "versionCode", "limit", "cursor", "parentCode", "ancestorCode", "level", "selectableOnly"]);
      const parentCode = nullableCodeQuery(params, "parentCode"), ancestorCode = stringQuery(params, "ancestorCode"), level = levelQuery(params, "level"), selectableOnly = booleanQuery(params, "selectableOnly");
      return areaJson(await host.kit.listRegions(ctx, {...selector(params), ...page(params), ...(parentCode === undefined ? {} : {parentCode}), ...(ancestorCode === undefined ? {} : {ancestorCode}), ...(level === undefined ? {} : {level}), ...(selectableOnly === undefined ? {} : {selectableOnly})}));
    }
    if (route === "region") { validateQuery(params, ["datasetId", "versionCode", "code"]); return areaJson(await host.kit.getRegion(ctx, {...selector(params), code: stringQuery(params, "code", true)!})); }
    if (route === "batch") {
      validateQuery(params, ["datasetId", "versionCode", "codes"]); const codes = params.getAll("codes");
      if (!codes.length || codes.length > 200) invalid(); codes.forEach(code);
      return areaJson(await host.kit.getRegions(ctx, {...selector(params), codes}));
    }
    if (route === "path") { validateQuery(params, ["datasetId", "versionCode", "code"]); return areaJson(await host.kit.getPath(ctx, {...selector(params), code: stringQuery(params, "code", true)!})); }
    if (route === "search") {
      validateQuery(params, ["datasetId", "versionCode", "limit", "cursor", "parentCode", "ancestorCode", "level", "selectableOnly", "keyword"]);
      const parentCode = nullableCodeQuery(params, "parentCode"), ancestorCode = stringQuery(params, "ancestorCode"), level = levelQuery(params, "level"), selectableOnly = booleanQuery(params, "selectableOnly"), keyword = stringQuery(params, "keyword", true)!;
      if (keyword.length > 100) invalid();
      return areaJson(await host.kit.search(ctx, {...selector(params), ...page(params), keyword, ...(parentCode === undefined ? {} : {parentCode}), ...(ancestorCode === undefined ? {} : {ancestorCode}), ...(level === undefined ? {} : {level}), ...(selectableOnly === undefined ? {} : {selectableOnly})}));
    }
    if (route === "tree") { validateQuery(params, ["datasetId", "versionCode", "ancestorCode", "depth", "maxNodes"]); const ancestorCode = stringQuery(params, "ancestorCode"), depth = intQuery(params, "depth", 1, 3), maxNodes = intQuery(params, "maxNodes", 1, 5000); return areaJson(await host.kit.getTree(ctx, {...selector(params), ...(ancestorCode === undefined ? {} : {ancestorCode}), ...(depth === undefined ? {} : {depth}), ...(maxNodes === undefined ? {} : {maxNodes})})); }
    if (route === "validate") { validateQuery(params, []); requireAreaJson(request); const input = parseValidationInput(await readAreaJsonBody(request)); const targetLevel = input.targetLevel ?? 3; return areaJson(await host.kit.validateSelection(ctx, input, {policy: host.previewPolicy(ctx, targetLevel), versionPolicy: "specified-ready"})); }
    if (route === "admin/presentation") { validateQuery(params, []); requireAreaJson(request); return areaJson(await host.kit.updatePresentation(ctx, presentationInput(await readAreaJsonBody(request)))); }
    validateQuery(params, ["datasetId", "versionCode"]); return areaJson(await host.kit.getDatasetReport(ctx, selector(params)));
  } catch (cause) { return areaError(cause); }
}
