import type { BatchResult, DatasetAdminReport, DatasetListInput, DatasetPage, DatasetSummary, ListInput, Page, PageInput,
  PathResult, PresentationInput, RegionSummary, SearchHit, SearchInput, SelectionResult, TreeInput, TreeResult,
  ValidationInput, VersionSelector } from "../types.js";

export interface AreaClient {
  getDataset(input?: VersionSelector, signal?: AbortSignal): Promise<DatasetSummary>;
  listDatasets(input?: DatasetListInput, signal?: AbortSignal): Promise<DatasetPage>;
  listProvinces(input?: VersionSelector & PageInput, signal?: AbortSignal): Promise<Page<RegionSummary>>;
  listChildren(input: ListInput & {parentCode: string}, signal?: AbortSignal): Promise<Page<RegionSummary>>;
  listRegions(input: ListInput, signal?: AbortSignal): Promise<Page<RegionSummary>>;
  getRegion(input: VersionSelector & {code: string}, signal?: AbortSignal): Promise<RegionSummary>;
  getRegions(input: VersionSelector & {codes: readonly string[]}, signal?: AbortSignal): Promise<BatchResult>;
  getPath(input: VersionSelector & {code: string}, signal?: AbortSignal): Promise<PathResult>;
  search(input: SearchInput, signal?: AbortSignal): Promise<Page<SearchHit>>;
  getTree(input?: TreeInput, signal?: AbortSignal): Promise<TreeResult>;
  validateSelection(input: ValidationInput, signal?: AbortSignal): Promise<SelectionResult>;
}

export interface AreaAdminClient extends AreaClient {
  updatePresentation(input: PresentationInput, signal?: AbortSignal): Promise<RegionSummary>;
  getDatasetReport(input: VersionSelector, signal?: AbortSignal): Promise<DatasetAdminReport>;
}
