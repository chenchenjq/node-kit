import { AreaKitError, sanitizeError } from "../errors.js";
import type { DatasetAdminReport, ImportReport, Level, PresentationInput, PresentationPatch,
  RegionSummary, VersionSelector } from "../types.js";
import type { AreaKit, AreaKitOptions, AuthorizationRequest } from "./contracts.js";
import type { DatasetRecord, ReadView } from "./ports.js";
import { summarizeNodes } from "./summary.js";

const LEVELS: readonly Level[] = [1, 2, 3, 4, 5];
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

function invalid(): never { throw new AreaKitError("INVALID_ARGUMENT"); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
}
function code(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length) invalid();
}
function selector(value: VersionSelector): VersionSelector {
  object(value);
  if (value.datasetId !== undefined) code(value.datasetId);
  if (value.versionCode !== undefined) code(value.versionCode);
  return { ...(value.datasetId === undefined ? {} : { datasetId: value.datasetId }),
    ...(value.versionCode === undefined ? {} : { versionCode: value.versionCode }) };
}
function int32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}
function hasOwn(value: object, key: string): boolean { return Object.hasOwn(value, key); }

function patch(value: unknown): PresentationPatch {
  object(value);
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => key !== "displayName" && key !== "sort" && key !== "enabled")) invalid();
  const result: PresentationPatch = {};
  if (hasOwn(value, "displayName")) {
    if (value.displayName !== null && typeof value.displayName !== "string") invalid();
    result.displayName = typeof value.displayName === "string" ? value.displayName.trim() || null : null;
  }
  if (hasOwn(value, "sort")) {
    if (!int32(value.sort)) invalid();
    result.sort = value.sort;
  }
  if (hasOwn(value, "enabled")) {
    if (typeof value.enabled !== "boolean") invalid();
    result.enabled = value.enabled;
  }
  return result;
}

function presentationInput(value: PresentationInput): { selector: VersionSelector; code: string; revision: number; patch: PresentationPatch } {
  object(value);
  const version = selector(value);
  code(value.code);
  if (!Number.isInteger(value.revision) || value.revision < 1 || value.revision > INT32_MAX) invalid();
  return { selector: version, code: value.code, revision: value.revision, patch: patch(value.patch) };
}
function ref(dataset: DatasetRecord) { return { datasetId: dataset.datasetId, versionCode: dataset.versionCode }; }
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function countValue(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function level(value: unknown): value is Level { return LEVELS.includes(value as Level); }
function report(value: unknown): ImportReport {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const counts = typeof raw.counts === "object" && raw.counts !== null && !Array.isArray(raw.counts)
    ? raw.counts as Record<string, unknown> : {};
  const sourceDigests = typeof raw.sourceDigests === "object" && raw.sourceDigests !== null && !Array.isArray(raw.sourceDigests)
    ? raw.sourceDigests as Record<string, unknown> : {};
  const databaseDigests = typeof raw.databaseDigests === "object" && raw.databaseDigests !== null && !Array.isArray(raw.databaseDigests)
    ? raw.databaseDigests as Record<string, unknown> : {};
  const copyCounts = Object.fromEntries(LEVELS.map(item => {
    const row = typeof counts[item] === "object" && counts[item] !== null && !Array.isArray(counts[item])
      ? counts[item] as Record<string, unknown> : {};
    return [item, { input: count(row.input), valid: count(row.valid), duplicate: count(row.duplicate), conflict: count(row.conflict),
      missingParent: count(row.missingParent), ancestorMismatch: count(row.ancestorMismatch), invalid: count(row.invalid) }];
  })) as ImportReport["counts"];
  const copyDigests = (rawDigests: Record<string, unknown>): Partial<Record<Level, string>> => Object.fromEntries(LEVELS
    .flatMap(item => typeof rawDigests[item] === "string" ? [[item, rawDigests[item]]] : [])) as Partial<Record<Level, string>>;
  const samples = Array.isArray(raw.samples) ? raw.samples.slice(0, 20).flatMap(sample => {
    if (typeof sample !== "object" || sample === null || Array.isArray(sample)) return [];
    const row = sample as Record<string, unknown>;
    return level(row.level) && (typeof row.code === "string" || row.code === null) && typeof row.reason === "string"
      ? [{ level: row.level, code: row.code, reason: row.reason }] : [];
  }) : [];
  return { passed: raw.passed === true, counts: copyCounts, issuesPath: typeof raw.issuesPath === "string" || raw.issuesPath === null
    ? raw.issuesPath : null, samples, digestAlgorithm: typeof raw.digestAlgorithm === "string" ? raw.digestAlgorithm : "",
    sourceDigests: copyDigests(sourceDigests) as ImportReport["sourceDigests"], databaseDigests: copyDigests(databaseDigests),
    inheritanceConflicts: count(raw.inheritanceConflicts) };
}
function progress(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>, result: Record<string, unknown> = {};
  if (level(raw.level)) result.level = raw.level;
  if (countValue(raw.recordsCommitted)) result.recordsCommitted = raw.recordsCommitted;
  if (countValue(raw.batchSize)) result.batchSize = raw.batchSize;
  if (typeof raw.inheritance === "object" && raw.inheritance !== null && !Array.isArray(raw.inheritance)) {
    const inheritance = raw.inheritance as Record<string, unknown>, copy: Record<string, unknown> = {};
    if (typeof inheritance.sourceId === "string") copy.sourceId = inheritance.sourceId;
    if (countValue(inheritance.conflicts)) copy.conflicts = inheritance.conflicts;
    if (typeof inheritance.completed === "boolean") copy.completed = inheritance.completed;
    if (Object.keys(copy).length) result.inheritance = copy;
  }
  return result;
}

/** Admin-only operations deliberately keep cache invalidation with the host: invalidate all process paths, search, tree and descendant state after a successful update. */
export function createManagementMethods<C>(options: AreaKitOptions<C>): Pick<AreaKit<C>, "updatePresentation" | "getDatasetReport"> {
  async function authorize(ctx: C, request: AuthorizationRequest): Promise<void> {
    if (await options.authorize(ctx, request) !== true) throw new AreaKitError("FORBIDDEN");
  }
  async function admin<T>(ctx: C, action: "admin.read" | "admin.write", work: () => Promise<T>): Promise<T> {
    try { await authorize(ctx, { action }); return await work(); }
    catch (error) { throw sanitizeError(error); }
  }
  async function resolve(view: ReadView, value: VersionSelector, absent: "NOT_INITIALIZED" | "VERSION_UNAVAILABLE"): Promise<DatasetRecord> {
    const dataset = await view.resolveDataset(value);
    if (!dataset) throw new AreaKitError(absent);
    return dataset;
  }
  return {
    updatePresentation: (ctx, input) => admin(ctx, "admin.write", async (): Promise<RegionSummary> => {
      const normalized = presentationInput(input);
      return options.store.write(async view => {
        const dataset = await resolve(view, normalized.selector, "VERSION_UNAVAILABLE");
        if (dataset.status !== "ready") throw new AreaKitError("VERSION_UNAVAILABLE");
        await authorize(ctx, { action: "admin.write", ...ref(dataset), code: normalized.code });
        const saved = await view.updatePresentation(dataset.datasetId, normalized.code, normalized.revision, normalized.patch);
        return (await summarizeNodes(view, dataset.datasetId, [saved]))[0]!;
      });
    }),
    getDatasetReport: (ctx, value) => admin(ctx, "admin.read", async (): Promise<DatasetAdminReport> => {
      const selected = selector(value);
      return options.store.read(async view => {
        const dataset = await resolve(view, selected, selected.datasetId === undefined && selected.versionCode === undefined
          ? "NOT_INITIALIZED" : "VERSION_UNAVAILABLE");
        await authorize(ctx, { action: "admin.read", ...ref(dataset) });
        return { ...ref(dataset), progress: progress(dataset.progress), report: report(dataset.report) };
      });
    }),
  };
}
