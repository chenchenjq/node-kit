import type { AreaStore } from "./ports.js";
import type { BatchResult, DatasetAdminReport, DatasetListInput, DatasetPage, DatasetSummary,
  ListInput, Page, PageInput, PathResult, PresentationInput, RegionSummary, SearchHit, SearchInput,
  SelectionResult, TreeInput, TreeResult, ValidationInput, ValidationOptions, VersionSelector } from "../types.js";

export interface AuthorizationRequest {
  action: "read" | "admin.read" | "admin.write";
  datasetId?: string;
  versionCode?: string;
  code?: string;
}
export interface AreaKitOptions<C> {
  store: AreaStore;
  authorize(ctx: C, request: AuthorizationRequest): Promise<boolean>;
}
export interface AreaKit<C> {
  getDataset(ctx: C, selector?: VersionSelector): Promise<DatasetSummary>;
  listDatasets(ctx: C, input?: DatasetListInput): Promise<DatasetPage>;
  listProvinces(ctx: C, input?: VersionSelector & PageInput): Promise<Page<RegionSummary>>;
  listChildren(ctx: C, input: ListInput & {parentCode: string}): Promise<Page<RegionSummary>>;
  listRegions(ctx: C, input: ListInput): Promise<Page<RegionSummary>>;
  getRegion(ctx: C, input: VersionSelector & {code: string}): Promise<RegionSummary>;
  getRegions(ctx: C, input: VersionSelector & {codes: readonly string[]}): Promise<BatchResult>;
  getPath(ctx: C, input: VersionSelector & {code: string}): Promise<PathResult>;
  search(ctx: C, input: SearchInput): Promise<Page<SearchHit>>;
  getTree(ctx: C, input?: TreeInput): Promise<TreeResult>;
  /** Policy and version acceptance are trusted server options, never client-supplied input fields. */
  validateSelection(ctx: C, input: ValidationInput, options?: ValidationOptions): Promise<SelectionResult>;
  updatePresentation(ctx: C, input: PresentationInput): Promise<RegionSummary>;
  getDatasetReport(ctx: C, selector: VersionSelector): Promise<DatasetAdminReport>;
}
export type AreaReadKit<C> = Pick<AreaKit<C>, "getDataset" | "listDatasets" | "listProvinces"
  | "listChildren" | "listRegions" | "getRegion" | "getRegions" | "getPath" | "search" | "getTree">;
