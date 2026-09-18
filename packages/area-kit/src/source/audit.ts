import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ImportReport, Level, LevelReport, NodeKind } from "../types.js";
import { ANCESTOR_FIELDS, CODE_LENGTHS, readCsvRows } from "./csv.js";
import type { SourceRow } from "./csv.js";
import { externalSort, readJsonLines, sourceTuple } from "./external-sort.js";
import { classifyNode } from "./kinds.js";
import { SOURCE_MANIFEST } from "./manifest.js";
import type { SourceManifest, SourceFile } from "./manifest.js";

export interface CanonicalRow {
  level: Level; code: string; sourceName: string; parentCode: string | null;
  nodeKind: NodeKind; ancestorCodes: string[];
}
export interface AuditResult {
  manifest: SourceManifest; sourceDirectory: string; directory: string; normalizedFiles: Record<Level, string>; report: ImportReport;
}
export function canonicalDigestLine(row: CanonicalRow): string {
  return JSON.stringify([row.level, row.code, row.sourceName, row.parentCode, row.nodeKind]) + "\n";
}
export function digestCanonicalRows(rows: readonly CanonicalRow[]): string {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(canonicalDigestLine(row), "utf8");
  return digest.digest("hex");
}
export function readCanonicalRows(file: string): AsyncIterable<CanonicalRow> { return readJsonLines<CanonicalRow>(file); }
const LEVELS: Level[] = [1,2,3,4,5];
function emptyCounts(): LevelReport { return { input: 0, valid: 0, duplicate: 0, conflict: 0, missingParent: 0, ancestorMismatch: 0, invalid: 0 }; }
async function verified(file: string, expected: SourceFile): Promise<boolean> {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(file)) { bytes += (chunk as Buffer).byteLength; hash.update(chunk as Buffer); }
  return bytes === expected.bytes && hash.digest("hex") === expected.sha256;
}
/** The optional manifest is an internal controlled test seam, never a CLI argument. */
export async function auditSource(sourceDirectory: string, outputDirectory: string, manifest: SourceManifest = SOURCE_MANIFEST, onProgress?: (level: Level, valid: number) => void): Promise<AuditResult> {
  const directory = resolve(outputDirectory);
  if (directory === resolve(sourceDirectory)) throw new Error("Audit output must be separate from source");
  await mkdir(directory, { recursive: true });
  const normalizedFiles = Object.fromEntries(LEVELS.map(level => [level, join(directory, `normalized-${level}.jsonl`)])) as Record<Level, string>;
  const report: ImportReport = {
    passed: true, counts: Object.fromEntries(LEVELS.map(level => [level, emptyCounts()])) as Record<Level, LevelReport>,
    issuesPath: join(directory, "issues.jsonl"), samples: [], digestAlgorithm: "sha256:utf8-json-array-lines:code-ascii:v1",
    sourceDigests: {} as Record<Level, string>, databaseDigests: {}, inheritanceConflicts: 0,
  };
  const issues = await open(report.issuesPath!, "w");
  const indexes = new Map<Level, Map<string, CanonicalRow>>();
  const samples = new Map<Level, number>();
  async function issue(level: Level, code: string | null, reason: string, raw?: SourceRow, occurrences = 1) {
    report.passed = false;
    await issues.write(JSON.stringify({ level, code, reason, ...(raw ? { raw } : {}), occurrences }) + "\n");
    if ((samples.get(level) ?? 0) < 20) { report.samples.push({ level, code, reason }); samples.set(level, (samples.get(level) ?? 0) + 1); }
  }
  try {
    for (const level of LEVELS) {
      const counts = report.counts[level];
      const output = await open(normalizedFiles[level], "w");
      const hash = createHash("sha256");
      const currentIndex = new Map<string, CanonicalRow>();
      let first: SourceRow | undefined, firstOccurrences = 0, previousTuple: string | undefined;
      let hasConflict = false, groupInvalid = false;
      let candidate: CanonicalRow | undefined;
      async function finish() {
        if (!first) return;
        if (hasConflict) counts.conflict++;
        else if (!groupInvalid && candidate) {
          counts.valid++;
          await output.write(JSON.stringify(candidate) + "\n"); hash.update(canonicalDigestLine(candidate), "utf8");
          if (level < 5) currentIndex.set(candidate.code, candidate);
        }
      }
      try {
        const files = manifest.files.filter(file => file.level === level);
        if (files.length !== 1) throw new Error("Manifest must contain exactly one file for each level");
        const file = files[0]!;
        const path = join(resolve(sourceDirectory), file.path);
        if (!await verified(path, file)) throw new Error("Source checksum or byte count mismatch");
        for await (const raw of externalSort(readCsvRows(path, level), directory)) {
          counts.input++;
          if (first && raw.code !== first.code) {
            await finish(); first = undefined; firstOccurrences = 0; previousTuple = undefined; hasConflict = false; groupInvalid = false; candidate = undefined;
          }
          const tuple = sourceTuple(raw);
          if (!first) first = raw;
          else if (tuple === previousTuple) counts.duplicate++;
          else {
            if (!hasConflict) await issue(level, first.code!, "conflict", first, firstOccurrences);
            hasConflict = true;
          }
          if (hasConflict) await issue(level, raw.code!, "conflict", raw);
          else firstOccurrences++;
          previousTuple = tuple;
          const ancestorCodes = ANCESTOR_FIELDS.slice(0, level - 1).map(field => raw[field]!);
          const base = { level, code: raw.code!, sourceName: raw.name!, parentCode: ancestorCodes.at(-1) ?? null, ancestorCodes };
          const malformed = !new RegExp(`^[0-9]{${CODE_LENGTHS[level - 1]}}$`).test(raw.code!) || !raw.name?.trim() ||
            ancestorCodes.some((code, index) => !new RegExp(`^[0-9]{${CODE_LENGTHS[index]}}$`).test(code));
          if (malformed) { counts.invalid++; groupInvalid = true; await issue(level, raw.code ?? null, "invalid", raw); }
          if (level > 1) {
            const parent = indexes.get((level - 1) as Level)?.get(base.parentCode!);
            if (!parent) { counts.missingParent++; groupInvalid = true; await issue(level, raw.code ?? null, "missingParent", raw); }
            else if (JSON.stringify([...parent.ancestorCodes, parent.code]) !== JSON.stringify(ancestorCodes)) {
              counts.ancestorMismatch++; groupInvalid = true; await issue(level, raw.code ?? null, "ancestorMismatch", raw);
            }
          }
          candidate = { ...base, nodeKind: classifyNode(manifest, base) };
        }
        await finish();
      } catch (error) {
        counts.invalid++;
        await issue(level, null, error instanceof Error ? error.message : "Source read failed");
        // Never expose a partially parsed level as verified canonical data.
        counts.valid = 0; currentIndex.clear();
        await output.truncate(0);
        report.sourceDigests[level] = createHash("sha256").digest("hex");
      } finally { await output.close(); }
      report.sourceDigests[level] ??= hash.digest("hex");
      if (level < 5) indexes.set(level, currentIndex);
      onProgress?.(level, counts.valid);
    }
  } finally { await issues.close(); }
  if (report.passed) { await rm(report.issuesPath!, { force: true }); report.issuesPath = null; }
  await writeFile(join(directory, "report.json"), JSON.stringify({ ...report,
    countingNotes: "valid counts unique codes passing every check; duplicate counts extra identical records; conflict counts codes with multiple source tuples; other issue counts count affected records and may overlap. Counts cannot be summed to derive valid.",
    manifest,
  }, null, 2) + "\n");
  return { manifest, sourceDirectory: resolve(sourceDirectory), directory, normalizedFiles, report };
}
