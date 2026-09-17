import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgSchema, pgTable,
  smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { PgTableFn } from "drizzle-orm/pg-core";
import { validateSchemaName } from "./schema-name.js";
export { validateSchemaName } from "./schema-name.js";
import type { Coverage, DatasetSummary, ImportReport, Level, NodeKind } from "../types.js";
import type { SourceFile } from "../source/manifest.js";

/** These definitions describe one library. The host explicitly executes its migration. */
export function createAreaTables(schemaName = "public") {
  validateSchemaName(schemaName);
  const table: PgTableFn<string | undefined> = schemaName === "public" ? pgTable : pgSchema(schemaName).table;
  const dataset = table("area_dataset", {
    id: uuid("id").primaryKey().defaultRandom(),
    versionCode: text("version_code").notNull(),
    source: text("source").notNull(),
    sourceCommit: text("source_commit").notNull(),
    rulesVersion: text("rules_version").notNull(),
    codeScheme: text("code_scheme").notNull(),
    dataAsOf: date("data_as_of").notNull(),
    sourcePublishedAt: date("source_published_at").notNull(),
    fileChecksums: jsonb("file_checksums").$type<SourceFile[]>().notNull(),
    coverage: jsonb("coverage").$type<Coverage>().notNull(),
    levelCounts: jsonb("level_counts").$type<Partial<Record<Level, number>>>().notNull().default({}),
    status: text("status").$type<DatasetSummary["status"]>().notNull().default("importing"),
    isActive: boolean("is_active").notNull().default(false),
    importProgress: jsonb("import_progress").$type<Record<string, unknown>>().notNull().default({}),
    importReport: jsonb("import_report").$type<ImportReport | Record<string, never>>().notNull().default({}),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }, t => [
    unique("area_dataset_version_code").on(t.versionCode),
    uniqueIndex("area_dataset_one_active").on(sql`(1)`).where(sql`${t.isActive}`),
    check("area_dataset_status", sql`${t.status} IN ('importing', 'ready', 'failed')`),
    check("area_dataset_active_ready", sql`NOT ${t.isActive} OR ${t.status} = 'ready'`),
    check("area_dataset_imported_ready", sql`(${t.status} = 'ready') = (${t.importedAt} IS NOT NULL)`),
  ]);
  const region = table("area_region", {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetId: uuid("dataset_id").notNull(),
    code: text("code").notNull(),
    sourceName: text("source_name").notNull(),
    level: smallint("level").$type<Level>().notNull(),
    parentId: uuid("parent_id"),
    nodeKind: text("node_kind").$type<NodeKind>().notNull(),
    displayName: text("display_name"),
    sort: integer("sort").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }, t => [
    unique("area_region_dataset_id_pair").on(t.datasetId, t.id),
    unique("area_region_dataset_code").on(t.datasetId, t.code),
    foreignKey({ name: "area_region_dataset", columns: [t.datasetId], foreignColumns: [dataset.id] }).onDelete("restrict"),
    foreignKey({ name: "area_region_same_dataset_parent", columns: [t.datasetId, t.parentId],
      foreignColumns: [t.datasetId, t.id] }).onDelete("restrict"),
    check("area_region_level", sql`${t.level} BETWEEN 1 AND 5`),
    check("area_region_revision", sql`${t.revision} > 0`),
    check("area_region_code_nonblank", sql`${t.code} ~ '[^[:space:]]'`),
    check("area_region_source_name_nonblank", sql`${t.sourceName} ~ '[^[:space:]]'`),
    check("area_region_node_kind", sql`${t.nodeKind} IN ('region', 'group', 'statisticalUnit', 'unknown')`),
    check("area_region_root", sql`(${t.level} = 1 AND ${t.parentId} IS NULL) OR (${t.level} > 1 AND ${t.parentId} IS NOT NULL)`),
    index("area_region_parent_sort_code").on(t.datasetId, t.parentId, t.sort, t.code),
    index("area_region_level_sort_code").on(t.datasetId, t.level, t.sort, t.code),
  ]);
  return { dataset, region };
}

export type AreaTables = ReturnType<typeof createAreaTables>;
