import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AreaKitError } from "../errors.js";
import { auditSource, canonicalDigestLine, readCanonicalRows } from "../source/audit.js";
import type { AuditResult, CanonicalRow } from "../source/audit.js";
import type { DatasetSummary, Level } from "../types.js";
import type { ImportBackend, ImportOptions } from "./types.js";

const LEVELS: Level[] = [1, 2, 3, 4, 5];
export function assertBatchSize(size: number): void {
  if (!Number.isInteger(size) || size < 1 || size > 5000) throw new AreaKitError("INVALID_ARGUMENT");
}
function conflict(): never { throw new AreaKitError("IMPORT_CONFLICT"); }

/** Rebuild trusted canonical data from the original checksummed files on every attempt.
 * Keep this private snapshot for import so later edits to caller-owned files cannot alter a batch.
 */
async function verify(audit: AuditResult, directory: string, onProgress?: (message: string) => void): Promise<AuditResult> {
  if (!audit.report.passed || !audit.sourceDirectory || !audit.manifest.versionCode) conflict();
  const fresh = await auditSource(audit.sourceDirectory, directory, audit.manifest, (level, count) => onProgress?.(`source recheck level ${level}: ${count}`));
  if (!fresh.report.passed || fresh.report.digestAlgorithm !== audit.report.digestAlgorithm ||
      !isDeepStrictEqual(fresh.report.counts, audit.report.counts) ||
      !isDeepStrictEqual(fresh.report.sourceDigests, audit.report.sourceDigests)) conflict();
  for (const level of LEVELS) {
    const expected = readCanonicalRows(fresh.normalizedFiles[level])[Symbol.asyncIterator]();
    try {
      for await (const row of readCanonicalRows(audit.normalizedFiles[level])) {
        const next = await expected.next();
        if (next.done || !isDeepStrictEqual(row, next.value)) conflict();
      }
      if (!(await expected.next()).done) conflict();
    } finally { await expected.return?.(); }
  }
  return fresh;
}

export async function importAuditedSource(backend: ImportBackend, audit: AuditResult, options: ImportOptions = {}): Promise<DatasetSummary> {
  const report = structuredClone(audit.report);
  report.databaseDigests = {};
  let failureRecorded = false;
  function recordFailure() {
    report.passed = false;
    if (!failureRecorded) {
      report.samples.push({level: 1, code: null, reason: "Source or database import verification failed"});
      failureRecorded = true;
    }
  }
  try {
    const batchSize = options.batchSize ?? 1000;
    assertBatchSize(batchSize);
    const directory = await mkdtemp(join(tmpdir(), "area-import-verified-"));
    let ready: DatasetSummary;
    try {
      const source = await verify(audit, directory, options.onProgress);
      ready = await backend.withDatasetLock(source.manifest.versionCode, async session => {
        const dataset = await session.ensureDataset(source.manifest);
        try {
          if (dataset.status !== "ready") {
            for (const level of LEVELS) {
              let batch: CanonicalRow[] = [], recordsCommitted = 0;
              const digest = createHash("sha256");
              for await (const row of readCanonicalRows(source.normalizedFiles[level])) {
                digest.update(canonicalDigestLine(row));
                batch.push(row);
                if (batch.length === batchSize) {
                  recordsCommitted += batch.length;
                  await session.appendBatch(dataset.datasetId, batch, {level, recordsCommitted, batchSize});
                  if (recordsCommitted % (batchSize * 25) === 0) options.onProgress?.(`import level ${level}: ${recordsCommitted} committed`);
                  batch = [];
                }
              }
              if (batch.length) {
                recordsCommitted += batch.length;
                await session.appendBatch(dataset.datasetId, batch, {level, recordsCommitted, batchSize});
              }
              options.onProgress?.(`import level ${level}: ${recordsCommitted} committed (complete)`);
              if (recordsCommitted !== source.report.counts[level].valid || digest.digest("hex") !== source.report.sourceDigests[level]) conflict();
            }
          }
          if (dataset.status !== "ready" && options.inheritFromDatasetId !== undefined) {
            report.inheritanceConflicts = await session.inheritSettings(dataset.datasetId, options.inheritFromDatasetId);
          } else if (dataset.status === "ready") {
            report.inheritanceConflicts = dataset.report.inheritanceConflicts;
          } else {
            // A previous attempt may have committed inheritance before losing its
            // response. Omitting the option on retry must not erase that report.
            const inherited = dataset.progress.inheritance as {completed?: boolean; conflicts?: number} | undefined;
            if (inherited?.completed === true && typeof inherited.conflicts === "number" &&
                Number.isSafeInteger(inherited.conflicts) && inherited.conflicts >= 0) {
              report.inheritanceConflicts = inherited.conflicts;
            }
          }
          options.onProgress?.("database digest audit started");
          const database = await session.auditDataset(dataset.datasetId);
          options.onProgress?.("database digest audit completed");
          report.databaseDigests = database.digests;
          if (!database.passed || LEVELS.some(level => database.levelCounts[level] !== report.counts[level].valid ||
              database.digests[level] !== report.sourceDigests[level])) conflict();
          return await session.markReady(dataset.datasetId, report);
        } catch (error) {
          recordFailure();
          // Only resolved, non-ready datasets can fail, and only while their session still owns the lock.
          // A dead connection leaves importing state for verified replay on the next attempt.
          if (dataset.status !== "ready") await session.markFailed(dataset.datasetId, report).catch(() => undefined);
          throw error;
        }
      });
    } finally { await rm(directory, {recursive: true, force: true}); }
    await writeFile(join(audit.directory, "import-report.json"), JSON.stringify(report, null, 2) + "\n");
    return ready;
  } catch (error) {
    recordFailure();
    // Include failures before a dataset resolves; never leave a previous success as this attempt's report.
    await writeFile(join(audit.directory, "import-report.json"), JSON.stringify(report, null, 2) + "\n").catch(() => undefined);
    throw error;
  }
}
