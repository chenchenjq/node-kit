export type AdminLevel = 1 | 2 | 3 | 4 | 5;
export type NodeKind = "region" | "group" | "statisticalUnit" | "unknown";
export type MatchKind = "explicit" | "inferred" | "none";
export type ParseStatus = "matched" | "ambiguous" | "partial" | "unmatched";
export type OutputMode = "withStreet" | "withoutStreet";

export type WarningCode =
  | "AMBIGUOUS"
  | "CANDIDATES_TRUNCATED"
  | "LOW_CONFIDENCE"
  | "LEVELS_INFERRED"
  | "LEVELS_STRIPPED"
  | "STREET_MATCH_SUSPECT"
  | "NAME_MAY_BE_PLACE"
  | "RECIPIENTS_AMBIGUOUS"
  | "PHONE_MASKED"
  | "MULTIPLE_PHONES"
  | "TEXT_SPAN_UNRESOLVED"
  | "ENGINE_DETAIL_MISMATCH"
  | "HINT_CONFLICT"
  | "COVERAGE_UNKNOWN"
  | "RESIDUAL_TEXT"
  | "RECIPIENT_SUPPRESSED"
  | "EXTRACT_FAILED"
  | "PATH_MISMATCH";

export interface ParseWarning {
  code: WarningCode;
  message: string;
}

export interface LevelNode {
  code: string;
  name: string;
  sourceName: string;
  level: AdminLevel;
  match: MatchKind;
  matchedText?: string;
  matchedRange?: readonly [number, number];
  inferReason?: string;
}

export interface Recipient {
  name?: string;
  phone?: string;
  phoneExtension?: string;
  maskedPhone?: string;
  incompletePhone?: boolean;
  extraNames?: string[];
  extraPhones?: string[];
}

export interface AddressMeta {
  parserVersion: string;
  sdkVersion: string;
  regionSource: string;
  datasetId: string;
  regionVersion: string;
  codeScheme: string;
}

export interface AddressCandidate {
  candidateId: string;
  rank: number;
  confidence: number;
  scoreReasons: string[];
  status: ParseStatus;
  requiresReview: boolean;
  warnings: ParseWarning[];
  mode: OutputMode;
  province: LevelNode | null;
  city: LevelNode | null;
  district: LevelNode | null;
  street: LevelNode | null;
  regionGroup: LevelNode | null;
  deepestLevel: 0 | 1 | 2 | 3 | 4;
  detailedAddress: string;
  residualText: string;
  recipient: Recipient | null;
  streetFolded?: { text: string; restoredDetail: string; street: LevelNode };
}

export interface ParseResult {
  input: string;
  status: ParseStatus;
  requiresReview: boolean;
  warnings: ParseWarning[];
  candidates: AddressCandidate[];
  meta: AddressMeta;
}

export interface ParseOptions {
  extractRecipient?: boolean;
  maxCandidates?: number;
  allowInferred?: boolean;
  regionHint?: { provinceCode?: string; cityCode?: string; districtCode?: string };
}

export interface BatchItem {
  index: number;
  recordId?: string;
  ok: boolean;
  result?: ParseResult;
  error?: { code: string; message: string };
}

export interface ParseLimits {
  maxTextLength: number;
  maxBatchSize: number;
  maxCandidatesDefault: number;
  maxCandidatesHardCap: number;
}

export interface RegionNode {
  code: string;
  name: string;
  sourceName?: string;
  aliases?: readonly string[];
  level: AdminLevel;
  parentCode: string | null;
  kind: NodeKind;
}

export interface RegionSnapshot {
  datasetId: string;
  version: string;
  codeScheme: string;
  nodes: readonly RegionNode[];
}

export interface PathProblem {
  code: string;
  reason: string;
}

export interface PathCheck {
  ok: boolean;
  problems: PathProblem[];
}

export interface RegionProvider {
  readonly source: string;
  loadSnapshot(ctx: { datasetId: string; version: string }): Promise<RegionSnapshot>;
  validatePath(codes: readonly (string | null)[]): Promise<PathCheck>;
}
