import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { AreaKitError } from "../errors.js";
import { sameSourceMeaning } from "../import/inherit.js";
import { bindAreaStore } from "./store.js";
import { assertBatchSize } from "../import/runner.js";
import type { DatasetAudit, ImportBackend, ImportSession } from "../import/types.js";
import type { DatasetRecord, StoredRegion } from "../server/ports.js";
import { canonicalDigestLine } from "../source/audit.js";
import type { CanonicalRow } from "../source/audit.js";
import type { SourceManifest } from "../source/manifest.js";
import type { DatasetSummary, Level } from "../types.js";
import { validateSchemaName } from "./schema.js";

const LEVELS: Level[] = [1, 2, 3, 4, 5];
const DIGEST_ALGORITHM = "sha256:utf8-json-array-lines:code-ascii:v1";
function conflict(): never { throw new AreaKitError("IMPORT_CONFLICT"); }
function summary(record: DatasetRecord): DatasetSummary {
  const {fileChecksums: _files, progress: _progress, report: _report, ...value} = record;
  return value;
}
const DATASET_COLUMNS = `id AS "datasetId", version_code AS "versionCode", source,
  source_commit AS "sourceCommit", rules_version AS "rulesVersion", code_scheme AS "codeScheme",
  data_as_of::text AS "dataAsOf", source_published_at::text AS "sourcePublishedAt", coverage,
  level_counts AS "levelCounts", status, is_active AS "isActive", imported_at AS "importedAt",
  file_checksums AS "fileChecksums", import_progress AS progress, import_report AS report`;
function datasetRecord(row: Omit<DatasetRecord, "importedAt"> & { importedAt: Date | string | null }): DatasetRecord {
  return {...row, importedAt: row.importedAt instanceof Date ? row.importedAt.toISOString() : row.importedAt};
}
type RegionRow = CanonicalRow & {id: string; parentId: string | null; parentLevel: number | null};

function createSession(client: PoolClient, schema: string, versionCode: string): ImportSession {
  const datasets = `"${schema}".area_dataset`, regions = `"${schema}".area_region`;
  let current: DatasetRecord | undefined;
  let lastAudit: DatasetAudit | undefined;
  function requireDataset(id: string) { if (!current || current.datasetId !== id) conflict(); return current; }
  async function get(): Promise<DatasetRecord | undefined> {
    const result = await client.query(`SELECT ${DATASET_COLUMNS} FROM ${datasets} WHERE version_code=$1`, [versionCode]);
    return result.rows[0] ? datasetRecord(result.rows[0]) : undefined;
  }
  async function transaction<T>(work: () => Promise<T>, repeatableRead = false): Promise<T> {
    await client.query(repeatableRead ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN");
    try { const value = await work(); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  }
  return {
    async ensureDataset(manifest: SourceManifest) {
      if (manifest.versionCode !== versionCode) conflict();
      const existing = await get();
      if (existing) {
        const identity = {source:existing.source, sourceCommit:existing.sourceCommit, rulesVersion:existing.rulesVersion,
          versionCode:existing.versionCode, codeScheme:existing.codeScheme, dataAsOf:existing.dataAsOf,
          sourcePublishedAt:existing.sourcePublishedAt, coverage:existing.coverage, files:existing.fileChecksums};
        if (!isDeepStrictEqual(identity, manifest)) conflict();
        if (existing.status === "failed") await client.query(`UPDATE ${datasets} SET status='importing',updated_at=now() WHERE id=$1`, [existing.datasetId]);
      } else {
        await client.query(`INSERT INTO ${datasets}
          (id,version_code,source,source_commit,rules_version,code_scheme,data_as_of,source_published_at,file_checksums,coverage)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(),versionCode,manifest.source,manifest.sourceCommit,manifest.rulesVersion,manifest.codeScheme,
          manifest.dataAsOf,manifest.sourcePublishedAt,JSON.stringify(manifest.files),JSON.stringify(manifest.coverage)]);
      }
      current = (await get())!;
      return current;
    },
    async appendBatch(datasetId, rows, progress) {
      if (requireDataset(datasetId).status !== "importing") conflict();
      assertBatchSize(progress.batchSize);
      if (!rows.length || rows.length > progress.batchSize || !LEVELS.includes(progress.level) ||
          !Number.isSafeInteger(progress.recordsCommitted) || progress.recordsCommitted < rows.length) conflict();
      lastAudit = undefined;
      await transaction(async () => {
        // One bounded lookup includes the entire ancestor chain for each incoming row.
        const codes = [...new Set(rows.flatMap(row => [row.code, ...row.ancestorCodes]))];
        const result = await client.query<RegionRow>(`SELECT r.id,r.code,r.source_name AS "sourceName",r.level,
          r.node_kind AS "nodeKind",r.parent_id AS "parentId",p.code AS "parentCode",p.level AS "parentLevel"
          FROM ${regions} r LEFT JOIN ${regions} p ON p.id=r.parent_id AND p.dataset_id=r.dataset_id
          WHERE r.dataset_id=$1 AND r.code=ANY($2::text[])`, [datasetId,codes]);
        const found = new Map(result.rows.map(row => [row.code,row]));
        const incoming = new Set<string>();
        const missing: {row: CanonicalRow; parentId: string | null}[] = [];
        for (const row of rows) {
          if (row.level !== progress.level || incoming.has(row.code) || row.ancestorCodes.length !== row.level - 1 ||
              row.parentCode !== (row.ancestorCodes.at(-1) ?? null)) conflict();
          incoming.add(row.code);
          let parentId: string | null = null;
          for (let index = 0; index < row.ancestorCodes.length; index++) {
            const ancestor = found.get(row.ancestorCodes[index]!);
            if (!ancestor || ancestor.level !== index + 1 || ancestor.parentId !== parentId ||
                ancestor.parentCode !== (row.ancestorCodes[index - 1] ?? null)) conflict();
            parentId = ancestor.id;
          }
          const existing = found.get(row.code);
          if (existing) {
            if (existing.sourceName !== row.sourceName || existing.level !== row.level || existing.nodeKind !== row.nodeKind ||
                existing.parentId !== parentId || existing.parentCode !== row.parentCode) conflict();
          } else missing.push({row,parentId});
        }
        if (missing.length) {
          const parameters: unknown[] = [];
          const values = missing.map(({row,parentId}) => {
            const offset = parameters.length;
            parameters.push(randomUUID(),datasetId,row.code,row.sourceName,row.level,parentId,row.nodeKind);
            return `(${Array.from({length:7}, (_,index) => `$${offset + index + 1}`).join(",")})`;
          });
          // 5000 rows * 7 parameters = 35000, below PostgreSQL's parameter limit.
          await client.query(`INSERT INTO ${regions} (id,dataset_id,code,source_name,level,parent_id,node_kind) VALUES ${values.join(",")}`, parameters);
        }
        await client.query(`UPDATE ${datasets} SET import_progress=import_progress || $2::jsonb,updated_at=now() WHERE id=$1 AND status='importing'`,
          [datasetId,JSON.stringify(progress)]);
      });
    },
    async inheritSettings(targetId, sourceId) {
      if (requireDataset(targetId).status !== "importing" || targetId === sourceId) conflict();
      if (typeof sourceId !== "string" || !sourceId.trim()) throw new AreaKitError("INVALID_ARGUMENT");
      lastAudit = undefined;
      // The import advisory lock remains held on this connection. Every page of old
      // settings and both source paths belongs to one snapshot and one atomic commit.
      const conflicts = await transaction(async () => {
        const target = await get();
        if (!target || target.status !== "importing") conflict();
        const completed = target.progress.inheritance as {sourceId?: string; conflicts?: number; completed?: boolean} | undefined;
        if (completed?.completed === true) {
          if (completed.sourceId !== sourceId || !Number.isSafeInteger(completed.conflicts) || completed.conflicts! < 0) conflict();
          return completed.conflicts!;
        }
        return bindAreaStore(client,{schemaName:schema}).read(async view => {
          const source = await view.resolveDataset({datasetId:sourceId});
          if (!source || source.status !== "ready" || source.report.passed !== true) conflict();
          let after = "", conflicts = 0;
          for (;;) {
            // Only non-default local settings need transfer or conflict reporting.
            const page = await client.query<{code: string}>(`SELECT code FROM ${regions}
              WHERE dataset_id=$1 AND code COLLATE "C">$2 COLLATE "C"
              AND (display_name IS NOT NULL OR sort<>0 OR NOT enabled)
              ORDER BY code COLLATE "C" LIMIT 1000`, [sourceId,after]);
            const codes = page.rows.map(row => row.code);
            const oldPaths = await view.getPaths(sourceId,codes);
            const newPaths = await view.getPaths(targetId,codes);
            const settings: Pick<StoredRegion,"code" | "displayName" | "sort" | "enabled">[] = [];
            for (const code of codes) {
              const previous = oldPaths.get(code), next = newPaths.get(code);
              if (!previous || !next || !sameSourceMeaning(previous,next)) { conflicts++; continue; }
              const {displayName,sort,enabled} = previous.at(-1)!;
              settings.push({code,displayName,sort,enabled});
            }
            if (settings.length) await client.query(`UPDATE ${regions} AS r
              SET display_name=s."displayName",sort=s.sort,enabled=s.enabled,updated_at=now()
              FROM jsonb_to_recordset($2::jsonb) AS s(code text,"displayName" text,sort integer,enabled boolean)
              WHERE r.dataset_id=$1 AND r.code=s.code`, [targetId,JSON.stringify(settings)]);
            if (codes.length < 1000) break;
            after = codes.at(-1)!;
          }
          await client.query(`UPDATE ${datasets} SET import_progress=import_progress || $2::jsonb,updated_at=now()
            WHERE id=$1 AND status='importing'`, [targetId,JSON.stringify({inheritance:{sourceId,conflicts,completed:true}})]);
          return conflicts;
        });
      }, true);
      current = (await get())!;
      return conflicts;
    },
    async auditDataset(datasetId) {
      requireDataset(datasetId);
      const audit: DatasetAudit = {passed:true, levelCounts:{} as Record<Level,number>, digests:{} as Record<Level,string>};
      // A stable snapshot covers every keyset page and level.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        for (const level of LEVELS) {
          const hash = createHash("sha256"); let after = "", count = 0;
          for (;;) {
            const result = await client.query<RegionRow>(`SELECT r.code,r.source_name AS "sourceName",r.level,
              r.node_kind AS "nodeKind",r.parent_id AS "parentId",p.code AS "parentCode",p.level AS "parentLevel"
              FROM ${regions} r LEFT JOIN ${regions} p ON p.id=r.parent_id AND p.dataset_id=r.dataset_id
              WHERE r.dataset_id=$1 AND r.level=$2 AND r.code COLLATE "C">$3 COLLATE "C"
              ORDER BY r.code COLLATE "C" LIMIT 1000`, [datasetId,level,after]);
            for (const row of result.rows) {
              if (level === 1 ? row.parentId !== null : row.parentId === null || row.parentCode === null || row.parentLevel !== level - 1) audit.passed = false;
              hash.update(canonicalDigestLine(row)); count++;
            }
            if (result.rows.length < 1000) break;
            after = result.rows.at(-1)!.code;
          }
          audit.levelCounts[level] = count; audit.digests[level] = hash.digest("hex");
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
      lastAudit = audit;
      return audit;
    },
    async markFailed(datasetId, report) {
      const dataset = requireDataset(datasetId);
      if (dataset.status === "ready") return;
      await client.query(`UPDATE ${datasets} SET status='failed',import_report=$2,updated_at=now() WHERE id=$1 AND status<>'ready'`,
        [datasetId,JSON.stringify({...report,passed:false})]);
      current = (await get())!;
    },
    async markReady(datasetId, report) {
      const dataset = requireDataset(datasetId);
      if (!report.passed || report.digestAlgorithm !== DIGEST_ALGORITHM || !lastAudit?.passed || LEVELS.some(level =>
        lastAudit!.levelCounts[level] !== report.counts[level].valid || lastAudit!.digests[level] !== report.sourceDigests[level] ||
        lastAudit!.digests[level] !== report.databaseDigests[level])) conflict();
      if (dataset.status === "ready") return summary(dataset);
      await client.query(`UPDATE ${datasets} SET status='ready',level_counts=$2,import_report=$3,imported_at=now(),updated_at=now() WHERE id=$1 AND status='importing'`,
        [datasetId,JSON.stringify(lastAudit.levelCounts),JSON.stringify(report)]);
      current = (await get())!;
      return summary(current);
    },
  };
}

/** A session advisory lock and every write belong to the same physical connection. */
export function createPostgresImportBackend(pool: Pool, options: {schemaName?: string} = {}): ImportBackend {
  const schema = options.schemaName ?? "public";
  validateSchemaName(schema);
  return {
    async withDatasetLock(versionCode, work) {
      if (typeof versionCode !== "string" || !versionCode.trim()) throw new AreaKitError("INVALID_ARGUMENT");
      const client = await pool.connect();
      const key = JSON.stringify(["area-kit:import",schema,versionCode]);
      let locked = false, active = true, broken = false;
      const onError = () => { broken = true; };
      client.on("error", onError);
      try {
        const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key]).catch(error => {
          // The server may have acquired the lock even if the response never arrived.
          broken = true;
          throw error;
        });
        locked = lock.rows[0]?.locked === true;
        if (!locked) conflict();
        const session = createSession(client, schema, versionCode);
        const guarded = new Proxy(session, {get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (!active || broken) conflict();
            return Reflect.apply(value, target, args) as unknown;
          };
        }});
        return await work(guarded);
      } finally {
        active = false;
        if (locked && !broken) {
          try {
            const result = await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked", [key]);
            if (result.rows[0]?.unlocked !== true) broken = true;
          } catch { broken = true; }
        }
        client.release(broken);
        client.removeListener("error", onError);
      }
    },
  };
}
