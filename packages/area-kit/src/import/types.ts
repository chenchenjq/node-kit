import type { DatasetRecord } from "../server/ports.js";
import type { AuditResult, CanonicalRow } from "../source/audit.js";
import type { SourceManifest } from "../source/manifest.js";
import type { DatasetSummary, ImportReport, Level } from "../types.js";

export interface ImportProgress { level: Level; recordsCommitted: number; batchSize: number }
export interface DatasetAudit { levelCounts: Record<Level, number>; digests: Record<Level, string>; passed: boolean }
export interface ImportOptions { batchSize?: number; inheritFromDatasetId?: string; onProgress?: (message: string) => void }
export interface ImportSession {
  ensureDataset(manifest: SourceManifest): Promise<DatasetRecord>;
  appendBatch(datasetId: string, rows: readonly CanonicalRow[], progress: ImportProgress): Promise<void>;
  inheritSettings(targetId: string, sourceId: string): Promise<number>;
  auditDataset(datasetId: string): Promise<DatasetAudit>;
  markFailed(datasetId: string, report: ImportReport): Promise<void>;
  markReady(datasetId: string, report: ImportReport): Promise<DatasetSummary>;
}
export interface ImportBackend {
  withDatasetLock<T>(versionCode: string, work: (session: ImportSession) => Promise<T>): Promise<T>;
}
export type { AuditResult };
