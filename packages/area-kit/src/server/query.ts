import { AreaKitError, sanitizeError } from "../errors.js";
import type { DatasetRef, ListInput, Page, PageInput, RegionSummary, SearchHit, TreeNode, VersionSelector } from "../types.js";
import type { AreaKit, AreaKitOptions, AuthorizationRequest } from "./contracts.js";
import type { DatasetRecord, NodeQuery, ReadView, StoredRegion } from "./ports.js";
import { decodeCursor, encodeCursor, normalizeQuery } from "./cursor.js";
import { displayLabel, summarizeDataset, summarizeNodes } from "./summary.js";
import { createSelectionValidator } from "./selection.js";
import { createManagementMethods } from "./management.js";

function invalid(): never { throw new AreaKitError("INVALID_ARGUMENT"); }
function inputObject(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
}
function code(value: unknown): asserts value is string {
  // Codes are opaque strings: never trim, pad, or coerce them.
  if (typeof value !== "string" || !value.length) invalid();
}
function selectorInput(input: VersionSelector): void {
  inputObject(input);
  if (input.datasetId !== undefined) code(input.datasetId);
  if (input.versionCode !== undefined) code(input.versionCode);
}
function limitInput(input: PageInput): number {
  const limit = input.limit === undefined ? 50 : input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid();
  if (input.cursor !== undefined && typeof input.cursor !== "string") invalid();
  return limit;
}
function queryInput(input: ListInput): NodeQuery {
  if (input.parentCode !== undefined && input.parentCode !== null) code(input.parentCode);
  if (input.ancestorCode !== undefined) code(input.ancestorCode);
  if (input.level !== undefined && (!Number.isInteger(input.level) || input.level < 1 || input.level > 5)) invalid();
  if (input.selectableOnly !== undefined && typeof input.selectableOnly !== "boolean") invalid();
  const query: NodeQuery = {};
  if (input.parentCode !== undefined) query.parentCode = input.parentCode;
  if (input.ancestorCode !== undefined) query.ancestorCode = input.ancestorCode;
  if (input.level !== undefined) query.level = input.level;
  if (input.selectableOnly !== undefined) query.selectableOnly = input.selectableOnly;
  return normalizeQuery(query);
}
function ref(dataset: DatasetRecord): DatasetRef { return {datasetId: dataset.datasetId, versionCode: dataset.versionCode}; }
async function requiredNode(view: ReadView, datasetId: string, value: string): Promise<StoredRegion> {
  const node = (await view.findNodes(datasetId, [value])).find(row => row.code === value);
  if (!node) throw new AreaKitError("UNKNOWN_CODE");
  return node;
}
async function checkRange(view: ReadView, datasetId: string, query: NodeQuery): Promise<void> {
  const parent = typeof query.parentCode === "string" ? await requiredNode(view, datasetId, query.parentCode) : null;
  const ancestor = query.ancestorCode !== undefined ? await requiredNode(view, datasetId, query.ancestorCode) : null;
  if (query.level !== undefined && (parent && query.level !== parent.level + 1
    || ancestor && query.level <= ancestor.level || query.parentCode === null && query.level !== 1)) invalid();
  if (ancestor && query.parentCode === null) invalid();
  if (ancestor && parent) {
    const path = (await view.getPaths(datasetId, [parent.code])).get(parent.code);
    if (!path?.some(node => node.code === ancestor.code)) invalid();
  }
}

/** Every operation authorizes before storage; dataset resolution and all subsequent reads share one view. */
export function createAreaKit<C>(options: AreaKitOptions<C>): AreaKit<C> {
  async function authorize(ctx: C, request: AuthorizationRequest): Promise<void> {
    if (await options.authorize(ctx, request) !== true) throw new AreaKitError("FORBIDDEN");
  }
  async function guard<T>(ctx: C, work: () => Promise<T>): Promise<T> {
    try { await authorize(ctx, {action: "read"}); return await work(); }
    catch (error) { throw sanitizeError(error); }
  }
  async function read<T>(ctx: C, input: VersionSelector, work: (view: ReadView, dataset: DatasetRecord) => Promise<T>, targetCode?: string): Promise<T> {
    return guard(ctx, async () => {
      selectorInput(input);
      return options.store.read(async view => {
        const selector: VersionSelector = {};
        if (input.datasetId !== undefined) selector.datasetId = input.datasetId;
        if (input.versionCode !== undefined) selector.versionCode = input.versionCode;
        const dataset = await view.resolveDataset(selector);
        if (!dataset || dataset.status !== "ready") {
          throw new AreaKitError(input.datasetId === undefined && input.versionCode === undefined ? "NOT_INITIALIZED" : "VERSION_UNAVAILABLE");
        }
        const request: AuthorizationRequest = {action: "read", ...ref(dataset)};
        if (targetCode !== undefined) request.code = targetCode;
        await authorize(ctx, request);
        return work(view, dataset);
      });
    });
  }
  async function page(view: ReadView, dataset: DatasetRecord, input: PageInput, query: NodeQuery): Promise<Page<RegionSummary>> {
    const limit = limitInput(input);
    await checkRange(view, dataset.datasetId, query);
    const libraryKey = await view.getLibraryKey();
    const after = input.cursor === undefined ? null : decodeCursor(input.cursor, libraryKey, dataset.datasetId, query);
    const rows = await view.listNodes(dataset.datasetId, query, after, limit + 1);
    const hasMore = rows.length > limit, selected = rows.slice(0, limit), last = selected.at(-1);
    const items = await summarizeNodes(view, dataset.datasetId, selected);
    return {...ref(dataset), items, hasMore, nextCursor: hasMore && last
      ? encodeCursor(libraryKey, dataset.datasetId, query, {sort: last.sort, code: last.code}) : null};
  }
  return {
    ...createManagementMethods(options),
    validateSelection: createSelectionValidator(options),
    getDataset: (ctx, selector = {}) => read(ctx, selector, async (_view, dataset) => summarizeDataset(dataset)),
    listDatasets: (ctx, input = {}) => guard(ctx, async () => {
      inputObject(input); limitInput(input);
      if (input.includeUnavailable !== undefined && typeof input.includeUnavailable !== "boolean") invalid();
      if (input.includeUnavailable) await authorize(ctx, {action: "admin.read"});
      return options.store.read(async view => {
        const result = await view.listDatasets(input);
        for (const dataset of result.items) await authorize(ctx, {action: "read", datasetId: dataset.datasetId, versionCode: dataset.versionCode});
        return {items: result.items.map(summarizeDataset), hasMore: result.hasMore, nextCursor: result.nextCursor};
      });
    }),
    listProvinces: (ctx, input = {}) => read(ctx, input, (view, dataset) => page(view, dataset, input, normalizeQuery({level: 1, parentCode: null}))),
    listChildren: (ctx, input) => read(ctx, input, (view, dataset) => {
      code(input.parentCode);
      return page(view, dataset, input, queryInput(input));
    }),
    listRegions: (ctx, input) => read(ctx, input, (view, dataset) => page(view, dataset, input, queryInput(input))),
    getRegion: (ctx, input) => read(ctx, input, async (view, dataset) => {
      code(input.code);
      const node = await requiredNode(view, dataset.datasetId, input.code);
      return (await summarizeNodes(view, dataset.datasetId, [node]))[0]!;
    }, input?.code),
    getRegions: (ctx, input) => read(ctx, input, async (view, dataset) => {
      if (!Array.isArray(input.codes) || input.codes.length > 200) invalid();
      input.codes.forEach(code);
      const codes = [...new Set(input.codes)], found = await view.findNodes(dataset.datasetId, codes);
      const byCode = new Map(found.map(row => [row.code, row]));
      const rows = codes.flatMap(value => byCode.has(value) ? [byCode.get(value)!] : []);
      return {...ref(dataset), items: await summarizeNodes(view, dataset.datasetId, rows), missingCodes: codes.filter(value => !byCode.has(value))};
    }),
    getPath: (ctx, input) => read(ctx, input, async (view, dataset) => {
      code(input.code);
      await requiredNode(view, dataset.datasetId, input.code);
      const rows = (await view.getPaths(dataset.datasetId, [input.code])).get(input.code);
      if (!rows?.length) throw new AreaKitError("QUERY_FAILED");
      const nodes = await summarizeNodes(view, dataset.datasetId, rows);
      return {...ref(dataset), nodes, pathCodes: nodes.map(node => node.code), pathNames: nodes.map(node => node.label)};
    }, input?.code),
    search: (ctx, input) => read(ctx, input, async (view, dataset) => {
      if (typeof input.keyword !== "string" || !input.keyword.trim() || input.keyword.length > 100) invalid();
      const query = normalizeQuery({...queryInput(input), keyword: input.keyword.trim()});
      const result = await page(view, dataset, input, query);
      const paths = await view.getPaths(dataset.datasetId, result.items.map(item => item.code));
      const items: SearchHit[] = result.items.map(item => {
        const path = paths.get(item.code);
        if (!path?.length) throw new AreaKitError("QUERY_FAILED");
        return {...item, pathCodes: path.map(node => node.code), pathNames: path.map(displayLabel)};
      });
      return {...result, items};
    }),
    getTree: (ctx, input = {}) => read(ctx, input, async (view, dataset) => {
      if (input.ancestorCode !== undefined) code(input.ancestorCode);
      const cap = input.maxNodes === undefined ? 5000 : input.maxNodes;
      if (!Number.isInteger(cap) || cap < 1 || cap > 5000) invalid();
      const root = input.ancestorCode === undefined ? null : await requiredNode(view, dataset.datasetId, input.ancestorCode);
      const rootLevel = root?.level ?? 1;
      const depth = input.depth === undefined ? 4 - rootLevel : input.depth;
      if (!Number.isInteger(depth) || depth < 1 || depth > 3 || rootLevel + depth - 1 > 3) invalid();
      const rows = await view.readSmallTree(dataset.datasetId, {...(input.ancestorCode === undefined ? {} : {ancestorCode: input.ancestorCode}), depth, maxNodes: cap}, cap + 1);
      if (rows.length > cap) throw new AreaKitError("QUERY_LIMIT_EXCEEDED");
      const nodes = await summarizeNodes(view, dataset.datasetId, rows);
      const byCode = new Map<string, TreeNode>(nodes.map(node => [node.code, {...node, children: []}]));
      const items: TreeNode[] = [];
      for (const node of byCode.values()) {
        const parent = node.parentCode === null ? undefined : byCode.get(node.parentCode);
        if (parent) parent.children.push(node); else items.push(node);
      }
      return {...ref(dataset), items};
    }),
  };
}
