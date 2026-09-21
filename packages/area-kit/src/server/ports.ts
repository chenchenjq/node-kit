import type { DatasetListInput, DatasetPage, DatasetSummary, ImportReport, Level, NodeKind,
  PresentationPatch, TreeInput, VersionSelector } from "../types.js";
import type { SourceFile } from "../source/manifest.js";

export interface StoredRegion {
  code: string;
  sourceName: string;
  displayName: string | null;
  level: Level;
  parentCode: string | null;
  nodeKind: NodeKind;
  enabled: boolean;
  sort: number;
  revision: number;
}
export interface DatasetRecord extends DatasetSummary {
  fileChecksums: SourceFile[];
  progress: Record<string, unknown>;
  report: ImportReport;
}
export interface PageKey { sort: number; code: string }
export interface NodeQuery {
  parentCode?: string | null;
  level?: Level;
  ancestorCode?: string;
  keyword?: string;
  selectableOnly?: boolean;
}
export interface ChildFacts { hasChildren: boolean; hasNavigableChildren: boolean }
export interface ReadView {
  getLibraryKey(): Promise<string>;
  resolveDataset(selector: VersionSelector): Promise<DatasetRecord | null>;
  listDatasets(input: DatasetListInput): Promise<DatasetPage>;
  findNodes(datasetId: string, codes: readonly string[]): Promise<StoredRegion[]>;
  getPaths(datasetId: string, codes: readonly string[]): Promise<ReadonlyMap<string, StoredRegion[]>>;
  listNodes(datasetId: string, query: NodeQuery, after: PageKey | null, take: number): Promise<StoredRegion[]>;
  readSmallTree(datasetId: string, input: TreeInput, take: number): Promise<StoredRegion[]>;
  getChildFacts(datasetId: string, codes: readonly string[]): Promise<ReadonlyMap<string, ChildFacts>>;
}
export interface WriteView extends ReadView {
  updatePresentation(datasetId: string, code: string, revision: number, patch: PresentationPatch): Promise<StoredRegion>;
  setActive(datasetId: string): Promise<void>;
}
export interface AreaStore {
  read<T>(work: (view: ReadView) => Promise<T>): Promise<T>;
  write<T>(work: (view: WriteView) => Promise<T>): Promise<T>;
}
