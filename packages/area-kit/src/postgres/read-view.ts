import { and, asc, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { alias, getTableConfig } from "drizzle-orm/pg-core";
import { AreaKitError } from "../errors.js";
import type { DatasetRecord, ReadView, StoredRegion, ChildFacts } from "../server/ports.js";
import type { DatasetSummary, ImportReport } from "../types.js";
import type { AreaTables } from "./schema.js";

type RegionTable = AreaTables["region"];
type RegionColumns = { [K in keyof RegionTable["_"]["columns"]]: SQLWrapper };
type RegionRow = StoredRegion & Record<string, unknown>;
function columns(r: RegionColumns, parent: RegionColumns): SQL {
  return sql`${r.code} AS code, ${r.sourceName} AS "sourceName", ${r.displayName} AS "displayName",
    ${r.level} AS level, ${parent.code} AS "parentCode", ${r.nodeKind} AS "nodeKind",
    ${r.enabled} AS enabled, ${r.sort} AS sort, ${r.revision} AS revision`;
}
function summary(row: AreaTables["dataset"]["$inferSelect"]): DatasetSummary {
  return { datasetId: row.id, versionCode: row.versionCode, source: row.source, sourceCommit: row.sourceCommit,
    rulesVersion: row.rulesVersion, codeScheme: row.codeScheme, dataAsOf: row.dataAsOf,
    sourcePublishedAt: row.sourcePublishedAt, coverage: row.coverage, levelCounts: row.levelCounts,
    status: row.status, isActive: row.isActive, importedAt: row.importedAt?.toISOString() ?? null };
}
function record(row: AreaTables["dataset"]["$inferSelect"]): DatasetRecord {
  return { ...summary(row), fileChecksums: row.fileChecksums, progress: row.importProgress,
    report: row.importReport as ImportReport };
}
function literalLike(value: string): string { return value.replace(/[\\%_]/g, "\\$&"); }

/** One bounded ancestry check. An invalid chain is never considered navigable. */
function effectiveEnabled(table: RegionTable, r: RegionColumns): SQL {
  const a = alias(table, "enabled_parent");
  return sql`(WITH RECURSIVE lineage AS (
    SELECT ${r.id} AS id, ${r.parentId} AS parent_id, ${r.level} AS level, ${r.enabled} AS enabled, 1 AS depth
    UNION ALL
    SELECT ${a.id}, ${a.parentId}, ${a.level}, ${a.enabled}, lineage.depth + 1
    FROM ${table} AS enabled_parent JOIN lineage ON ${a.id} = lineage.parent_id
      AND ${a.datasetId} = ${r.datasetId} AND ${a.level} = lineage.level - 1
    WHERE lineage.depth < 5
  ) SELECT bool_and(enabled) AND bool_or(level = 1 AND parent_id IS NULL) FROM lineage)`;
}

/** The caller owns transaction lifecycle; stores wrap this view with a callback lifetime guard. */
export function createReadView(db: NodePgDatabase, tables: AreaTables): ReadView {
  const { dataset: d, region: table } = tables;
  const r = alias(table, "r"); const p = alias(table, "p");
  const from = sql`${table} AS r LEFT JOIN ${table} AS p
    ON ${p.id} = ${r.parentId} AND ${p.datasetId} = ${r.datasetId}`;
  const view: ReadView = {
    async getLibraryKey() {
      const result = await db.execute<{ database: string }>(sql`SELECT current_database() AS database`);
      return JSON.stringify([result.rows[0]!.database, getTableConfig(d).schema ?? "public", "area_dataset", "area_region"]);
    },
    async resolveDataset(selector) {
      // Dataset ids are UUIDs in this adapter. An opaque unknown selector must not leak a SQL cast error.
      if (selector.datasetId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selector.datasetId)) return null;
      const clauses: SQL[] = [];
      if (selector.datasetId !== undefined) clauses.push(eq(d.id, selector.datasetId));
      if (selector.versionCode !== undefined) clauses.push(eq(d.versionCode, selector.versionCode));
      if (clauses.length === 0) clauses.push(eq(d.isActive, true));
      const [row] = await db.select().from(d).where(and(...clauses)).limit(1);
      return row ? record(row) : null;
    },
    async listDatasets(input) {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AreaKitError("INVALID_ARGUMENT");
      const libraryKey = await view.getLibraryKey();
      const includeUnavailable = input.includeUnavailable ?? false;
      const clauses: SQL[] = includeUnavailable ? [] : [eq(d.status, "ready")];
      if (input.cursor !== undefined) {
        try {
          if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
          const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
          if (cursor.v !== 1 || cursor.libraryKey !== libraryKey || cursor.includeUnavailable !== includeUnavailable
            || typeof cursor.versionCode !== "string" || typeof cursor.datasetId !== "string"
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.datasetId)
            || Object.keys(cursor).sort().join() !== "datasetId,includeUnavailable,libraryKey,v,versionCode") throw new Error();
          clauses.push(sql`(${d.versionCode}, ${d.id}) > (${cursor.versionCode}, ${cursor.datasetId}::uuid)`);
        } catch { throw new AreaKitError("INVALID_ARGUMENT"); }
      }
      const rows = await db.select().from(d).where(and(...clauses)).orderBy(asc(d.versionCode), asc(d.id)).limit(limit + 1);
      const hasMore = rows.length > limit; const items = rows.slice(0, limit).map(summary);
      const last = items.at(-1);
      return { items, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: 1, libraryKey,
        includeUnavailable, versionCode: last.versionCode, datasetId: last.datasetId })).toString("base64url") : null };
    },
    async findNodes(datasetId, codes) {
      if (codes.length === 0) return [];
      const result = await db.execute<RegionRow>(sql`SELECT ${columns(r, p)} FROM ${from}
        WHERE ${r.datasetId} = ${datasetId} AND ${r.code} = ANY(${sql.param([...codes])}::text[]) ORDER BY ${r.code}`);
      return result.rows;
    },
    async getPaths(datasetId, codes) {
      const paths = new Map<string, StoredRegion[]>();
      if (codes.length === 0) return paths;
      const a = alias(table, "a");
      const result = await db.execute<RegionRow & { seed: string }>(sql`WITH RECURSIVE paths AS (
        SELECT ${r.code} AS seed, ${r.id} AS id, ${r.parentId} AS parent_id, 1 AS depth
        FROM ${table} AS r WHERE ${r.datasetId} = ${datasetId} AND ${r.code} = ANY(${sql.param([...codes])}::text[])
        UNION ALL
        SELECT paths.seed, ${a.id}, ${a.parentId}, paths.depth + 1
        FROM ${table} AS a JOIN paths ON ${a.id} = paths.parent_id
        WHERE ${a.datasetId} = ${datasetId} AND paths.depth < 5
      ) SELECT paths.seed, ${columns(r, p)} FROM paths JOIN ${table} AS r ON ${r.id} = paths.id
        AND ${r.datasetId} = ${datasetId}
        LEFT JOIN ${table} AS p ON ${p.id} = ${r.parentId} AND ${p.datasetId} = ${datasetId}
      ORDER BY paths.seed, ${r.level}`);
      for (const { seed, ...row } of result.rows) {
        const path = paths.get(seed) ?? []; path.push(row); paths.set(seed, path);
      }
      for (const [code, path] of paths) {
        if (path[0]?.level !== 1 || path[0].parentCode !== null || path.at(-1)?.code !== code
          || path.some((row, i) => row.level !== i + 1 || (i > 0 && row.parentCode !== path[i - 1]!.code))) {
          throw new AreaKitError("QUERY_FAILED");
        }
      }
      return paths;
    },
    async listNodes(datasetId, query, after, take) {
      if (!Number.isInteger(take) || take < 1) throw new AreaKitError("INVALID_ARGUMENT");
      const clauses: SQL[] = [eq(r.datasetId, datasetId)];
      if (query.parentCode === null) clauses.push(sql`${r.parentId} IS NULL`);
      else if (query.parentCode !== undefined) clauses.push(eq(p.code, query.parentCode));
      if (query.level !== undefined) clauses.push(eq(r.level, query.level));
      if (query.keyword !== undefined) {
        const escaped = literalLike(query.keyword);
        clauses.push(sql`(${r.sourceName} LIKE ${`%${escaped}%`} OR ${r.displayName} LIKE ${`%${escaped}%`}
          OR ${r.code} LIKE ${`${escaped}%`})`);
      }
      if (after) clauses.push(sql`(${r.sort}, ${r.code}) > (${after.sort}, ${after.code})`);
      if (query.selectableOnly) clauses.push(sql`${r.nodeKind} <> 'group' AND ${effectiveEnabled(table, r)}`);
      let prefix = sql``;
      if (query.ancestorCode !== undefined) {
        const a = alias(table, "a");
        prefix = sql`WITH RECURSIVE descendants AS (
          SELECT ${a.id} AS id, ${a.level} AS level, 0 AS depth FROM ${table} AS a
            WHERE ${a.datasetId} = ${datasetId} AND ${a.code} = ${query.ancestorCode}
          UNION ALL
          SELECT ${a.id}, ${a.level}, descendants.depth + 1 FROM ${table} AS a
            JOIN descendants ON ${a.parentId} = descendants.id AND ${a.level} = descendants.level + 1
            WHERE ${a.datasetId} = ${datasetId} AND descendants.depth < 4
        )`;
        clauses.push(sql`${r.id} IN (SELECT id FROM descendants WHERE depth > 0)`);
      }
      const result = await db.execute<RegionRow>(sql`${prefix} SELECT ${columns(r, p)} FROM ${from}
        WHERE ${and(...clauses)} ORDER BY ${r.sort}, ${r.code} LIMIT ${take}`);
      return result.rows;
    },
    async readSmallTree(datasetId, input, take) {
      const depth = input.depth ?? 3;
      if (!Number.isInteger(depth) || depth < 1 || depth > 3
        || !Number.isInteger(take) || take < 1 || take > 5001) throw new AreaKitError("INVALID_ARGUMENT");
      const a = alias(table, "a");
      const seed = input.ancestorCode === undefined
        ? sql`${a.parentId} IS NULL AND ${a.level} = 1` : eq(a.code, input.ancestorCode);
      const result = await db.execute<RegionRow>(sql`WITH RECURSIVE subtree AS (
        SELECT ${a.id} AS id, ${a.level} AS level, 1 AS depth FROM ${table} AS a
          WHERE ${a.datasetId} = ${datasetId} AND ${seed} AND ${a.level} <= 3
        UNION ALL
        SELECT ${a.id}, ${a.level}, subtree.depth + 1 FROM ${table} AS a
          JOIN subtree ON ${a.parentId} = subtree.id AND ${a.level} = subtree.level + 1
          WHERE ${a.datasetId} = ${datasetId} AND subtree.depth < ${depth} AND ${a.level} <= 3
      ) SELECT ${columns(r, p)} FROM subtree JOIN ${table} AS r ON ${r.id} = subtree.id
        AND ${r.datasetId} = ${datasetId}
        LEFT JOIN ${table} AS p ON ${p.id} = ${r.parentId} AND ${p.datasetId} = ${datasetId}
        ORDER BY ${r.sort}, ${r.code} LIMIT ${take}`);
      return result.rows;
    },
    async getChildFacts(datasetId, codes) {
      const facts = new Map<string, ChildFacts>(codes.map(code => [code, { hasChildren: false, hasNavigableChildren: false }]));
      if (codes.length === 0) return facts;
      const child = alias(table, "child");
      const result = await db.execute<{ code: string; hasChildren: boolean; hasNavigableChildren: boolean }>(sql`
        SELECT ${r.code} AS code,
          EXISTS(SELECT 1 FROM ${table} AS child WHERE ${child.datasetId} = ${datasetId}
            AND ${child.parentId} = ${r.id}) AS "hasChildren",
          (${effectiveEnabled(table, r)} AND EXISTS(SELECT 1 FROM ${table} AS child
            WHERE ${child.datasetId} = ${datasetId} AND ${child.parentId} = ${r.id}
              AND ${child.level} = ${r.level} + 1 AND ${child.enabled})) AS "hasNavigableChildren"
        FROM ${table} AS r WHERE ${r.datasetId} = ${datasetId} AND ${r.code} = ANY(${sql.param([...codes])}::text[])`);
      for (const { code, ...value } of result.rows) facts.set(code, value);
      return facts;
    },
  };
  return view;
}
