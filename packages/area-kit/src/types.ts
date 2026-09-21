export type Level = 1 | 2 | 3 | 4 | 5;
export type NodeKind = "region" | "group" | "statisticalUnit" | "unknown";
export type ChildrenState = "AVAILABLE" | "NONE_IN_SNAPSHOT" | "ALL_DISABLED";

export interface VersionSelector {
  datasetId?: string;
  versionCode?: string;
}

export interface DatasetRef {
  datasetId: string;
  versionCode: string;
}

export interface Coverage {
  levels: Level[];
  excluded: string[];
  description: string;
}

export interface DatasetSummary extends DatasetRef {
  source: string;
  sourceCommit: string;
  rulesVersion: string;
  codeScheme: string;
  dataAsOf: string;
  sourcePublishedAt: string;
  coverage: Coverage;
  levelCounts: Partial<Record<Level, number>>;
  status: "importing" | "ready" | "failed";
  isActive: boolean;
  importedAt: string | null;
}

export interface RegionSummary {
  code: string;
  sourceName: string;
  label: string;
  level: Level;
  parentCode: string | null;
  nodeKind: NodeKind;
  enabled: boolean;
  effectiveEnabled: boolean;
  navigable: boolean;
  selectable: boolean;
  hasChildren: boolean;
  childrenState: ChildrenState;
  sort: number;
  revision: number;
}

export interface Page<T> extends DatasetRef {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PageInput {
  limit?: number;
  cursor?: string;
}

export interface ListInput extends VersionSelector, PageInput {
  parentCode?: string | null;
  level?: Level;
  ancestorCode?: string;
  selectableOnly?: boolean;
}

export interface SearchInput extends ListInput {
  keyword: string;
}

export interface SearchHit extends RegionSummary {
  pathCodes: string[];
  pathNames: string[];
}

export interface PathResult extends DatasetRef {
  nodes: RegionSummary[];
  pathCodes: string[];
  pathNames: string[];
}

export interface BatchResult extends DatasetRef {
  items: RegionSummary[];
  missingCodes: string[];
}

export interface DatasetListInput extends PageInput {
  includeUnavailable?: boolean;
}

export interface DatasetPage {
  items: DatasetSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface PresentationPatch {
  displayName?: string | null;
  sort?: number;
  enabled?: boolean;
}

export interface PresentationInput extends VersionSelector {
  code: string;
  revision: number;
  patch: PresentationPatch;
}

export interface SelectionPolicy {
  allowEarlyTermination?: boolean;
  groupEndpointExceptions?: readonly {
    source: string;
    versionCode: string;
    codes: readonly string[];
  }[];
}

export type VersionPolicy = "active-only" | "specified-ready";

export interface ValidationInput extends VersionSelector {
  pathCodes: readonly string[];
  targetLevel?: Level;
}

export interface ValidationOptions {
  policy?: SelectionPolicy;
  versionPolicy?: VersionPolicy;
}

export type ErrorCode =
  | "NOT_INITIALIZED"
  | "UNKNOWN_CODE"
  | "VERSION_UNAVAILABLE"
  | "TARGET_LEVEL_NOT_REACHED"
  | "PARENT_MISMATCH"
  | "NOT_SELECTABLE"
  | "FORBIDDEN"
  | "QUERY_FAILED"
  | "INVALID_ARGUMENT"
  | "QUERY_LIMIT_EXCEEDED"
  | "REVISION_CONFLICT"
  | "IMPORT_CONFLICT"
  | "INVALID_CONFIG";

export type RejectionReason =
  | "NOT_INITIALIZED"
  | "UNKNOWN_CODE"
  | "VERSION_UNAVAILABLE"
  | "PARENT_MISMATCH"
  | "NOT_SELECTABLE"
  | "NAVIGATION_ONLY"
  | "TARGET_LEVEL_NOT_REACHED"
  | "TARGET_LEVEL_EXCEEDED"
  | "DATASET_NOT_ACCEPTED";

export type SelectionReason =
  | RejectionReason
  | "TARGET_REACHED"
  | "GROUP_ENDPOINT_EXCEPTION"
  | "EARLY_TERMINATION_ACCEPTED";

export interface ResolvedSelection extends DatasetRef {
  code: string;
  level: Level;
  actualLevel: Level;
  pathCodes: string[];
  pathNames: string[];
  candidatePathCodes: string[];
  targetLevel: Level;
  reachedTargetLevel: boolean;
  accepted: boolean;
  reason: SelectionReason;
}

export interface UnresolvedSelection {
  datasetId: string | null;
  versionCode: string | null;
  code: null;
  level: null;
  actualLevel: null;
  pathCodes: null;
  pathNames: null;
  candidatePathCodes: string[];
  targetLevel: Level;
  reachedTargetLevel: false;
  accepted: false;
  reason: RejectionReason;
}

export type SelectionResult = ResolvedSelection | UnresolvedSelection;

export interface AreaValue {
  datasetId: string;
  code: string;
  pathCodes?: string[];
  pathNames?: string[];
}

export interface TreeNode extends RegionSummary {
  children: TreeNode[];
}

export interface TreeInput extends VersionSelector {
  ancestorCode?: string;
  depth?: number;
  maxNodes?: number;
}

export interface TreeResult extends DatasetRef {
  items: TreeNode[];
}

export interface LevelReport {
  input: number;
  valid: number;
  duplicate: number;
  conflict: number;
  missingParent: number;
  ancestorMismatch: number;
  invalid: number;
}

export interface ImportReport {
  passed: boolean;
  counts: Record<Level, LevelReport>;
  issuesPath: string | null;
  samples: { level: Level; code: string | null; reason: string }[];
  digestAlgorithm: string;
  sourceDigests: Record<Level, string>;
  databaseDigests: Partial<Record<Level, string>>;
  inheritanceConflicts: number;
}

export interface DatasetAdminReport extends DatasetRef {
  progress: Record<string, unknown>;
  report: ImportReport;
}
