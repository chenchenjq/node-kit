import type { BatchResult, DatasetAdminReport, DatasetListInput, DatasetPage, DatasetSummary, ListInput, Page, PageInput,
  PathResult, PresentationInput, RegionSummary, SearchHit, SearchInput, SelectionResult, TreeInput, TreeResult,
  ValidationInput, VersionSelector } from "../types.js";
import type { AreaAdminClient } from "./contracts.js";
import { AreaClientError, decodeClientError, decodeSuccess } from "./transport.js";

export type { AreaAdminClient, AreaClient } from "./contracts.js";
export { AreaClientError } from "./transport.js";

type QueryValue = string | number | boolean | null | readonly string[] | undefined;

function query(input: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input) as [string, QueryValue][]) {
    if (value === undefined) continue;
    if (value === null) { params.append(key, ""); continue; }
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function createAreaClient(options: {baseURL: string; fetch?: typeof fetch}): AreaAdminClient {
  const baseURL = options.baseURL.replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!baseURL || typeof fetcher !== "function") throw new AreaClientError("INVALID_CONFIG");

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    try {
      const response = await fetcher(`${baseURL}/${path}`, init);
      let value: unknown;
      try { value = await response.json(); }
      catch (error) { if (isAbort(error)) throw error; throw new AreaClientError("QUERY_FAILED"); }
      if (!response.ok) throw decodeClientError(value);
      return decodeSuccess<T>(value);
    } catch (error) {
      if (isAbort(error) || error instanceof AreaClientError) throw error;
      throw new AreaClientError("QUERY_FAILED");
    }
  }
  function get<T>(path: string, input: object, signal?: AbortSignal): Promise<T> {
    return request<T>(`${path}${query(input)}`, {method: "GET", headers: {accept: "application/json"}, cache: "no-store",
      ...(signal === undefined ? {} : {signal})});
  }
  function send<T>(path: string, method: "POST" | "PATCH", input: unknown, signal?: AbortSignal): Promise<T> {
    return request<T>(path, {method, headers: {accept: "application/json", "content-type": "application/json"}, body: JSON.stringify(input),
      ...(signal === undefined ? {} : {signal})});
  }
  return {
    getDataset: (input: VersionSelector = {}, signal?: AbortSignal) => get<DatasetSummary>("dataset", input, signal),
    listDatasets: (input: DatasetListInput = {}, signal?: AbortSignal) => get<DatasetPage>("datasets", input, signal),
    listProvinces: (input: VersionSelector & PageInput = {}, signal?: AbortSignal) => get<Page<RegionSummary>>("provinces", input, signal),
    listChildren: (input: ListInput & {parentCode: string}, signal?: AbortSignal) => get<Page<RegionSummary>>("children", input, signal),
    listRegions: (input: ListInput, signal?: AbortSignal) => get<Page<RegionSummary>>("regions", input, signal),
    getRegion: (input: VersionSelector & {code: string}, signal?: AbortSignal) => get<RegionSummary>("region", input, signal),
    getRegions: (input: VersionSelector & {codes: readonly string[]}, signal?: AbortSignal) => get<BatchResult>("batch", input, signal),
    getPath: (input: VersionSelector & {code: string}, signal?: AbortSignal) => get<PathResult>("path", input, signal),
    search: (input: SearchInput, signal?: AbortSignal) => get<Page<SearchHit>>("search", input, signal),
    getTree: (input: TreeInput = {}, signal?: AbortSignal) => get<TreeResult>("tree", input, signal),
    validateSelection: (input: ValidationInput, signal?: AbortSignal) => send<SelectionResult>("validate", "POST", input, signal),
    updatePresentation: (input: PresentationInput, signal?: AbortSignal) => send<RegionSummary>("admin/presentation", "PATCH", input, signal),
    getDatasetReport: (input: VersionSelector, signal?: AbortSignal) => get<DatasetAdminReport>("admin/report", input, signal),
  };
}
