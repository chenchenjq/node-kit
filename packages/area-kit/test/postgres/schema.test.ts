import { expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { createAreaTables } from "../../src/postgres/schema.js";
import { areaMigrationSql } from "../../src/postgres/migration.js";
import { createPgHarness } from "./harness.js";
import type { PgHarness } from "./harness.js";

const province = { level: 1 as const, code: "01", sourceName: " 合成省 ", parentCode: null,
  nodeKind: "unknown" as const, ancestorCodes: [] };
const city = { level: 2 as const, code: "0101", sourceName: "合成市", parentCode: "01",
  nodeKind: "unknown" as const, ancestorCodes: ["01"] };
async function withHarness(run: (h: PgHarness) => Promise<void>) {
  const h = await createPgHarness();
  try { await run(h); } finally { await h.close(); }
}

it("rejects a parent row from another dataset at the database boundary", async () => {
  await withHarness(async h => {
    const a = await h.seedDataset(); const b = await h.seedDataset();
    const parent = await h.seedRegion(a, province);
    await expect(h.seedRegion(b, city, parent)).rejects.toMatchObject({ code: "23503" });
    await expect(h.seedRegion(a, city, parent)).resolves.toEqual(expect.any(String));
  });
});

it("rejects active importing or failed datasets and permits only one active ready dataset", async () => {
  await withHarness(async h => {
    for (const status of ["importing", "failed"] as const) {
      await expect(h.seedDataset({ status, isActive: true })).rejects.toMatchObject({ code: "23514" });
    }
    await h.seedDataset({ status: "ready", isActive: true });
    await expect(h.seedDataset({ status: "ready", isActive: true })).rejects.toMatchObject({ code: "23505" });
    await expect(h.seedDataset({ status: "ready" })).resolves.toEqual(expect.any(String));
  });
});

it("requires imported_at exactly for ready status, and rejects unknown status", async () => {
  await withHarness(async h => {
    const id = await h.seedDataset();
    for (const assignment of ["status='ready'", "imported_at=now()", "status='invalid'"]) {
      await expect(h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET ${assignment} WHERE id=$1`, [id]))
        .rejects.toMatchObject({ code: "23514" });
    }
    const ready = await h.seedDataset({ status: "ready" });
    await expect(h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET imported_at=NULL WHERE id=$1`, [ready]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(h.seedDataset({ versionCode: "synthetic:same:v1" })).resolves.toEqual(expect.any(String));
    await expect(h.seedDataset({ versionCode: "synthetic:same:v1" })).rejects.toMatchObject({ code: "23505" });
  });
});

it("enforces region level, revision, whitespace, kind, root, and per-dataset code constraints", async () => {
  await withHarness(async h => {
    const dataset = await h.seedDataset();
    const parent = await h.seedRegion(dataset, province);
    for (const assignment of ["level=0", "level=6", "revision=0", "revision=-1", "code=' '",
      "code=E'\\t\\n'", "source_name=' '", "source_name=E'\\t\\n'", "node_kind='invalid'", "parent_id=id"]) {
      await expect(h.pool.query(`UPDATE "${h.schemaName}".area_region SET ${assignment} WHERE id=$1`, [parent]))
        .rejects.toMatchObject({ code: "23514" });
    }
    await expect(h.seedRegion(dataset, city)).rejects.toMatchObject({ code: "23514" });
    await expect(h.seedRegion(dataset, province)).rejects.toMatchObject({ code: "23505" });
    await expect(h.seedRegion(await h.seedDataset(), province)).resolves.toEqual(expect.any(String));
    let previous = parent;
    for (const level of [2,3,4,5] as const) {
      previous = await h.seedRegion(dataset, { ...city, code: `01${level}`, level }, previous);
    }
  });
});

it("restricts dataset and parent deletion while referenced", async () => {
  await withHarness(async h => {
    const dataset = await h.seedDataset(); const parent = await h.seedRegion(dataset, province);
    await h.seedRegion(dataset, city, parent);
    await expect(h.pool.query(`DELETE FROM "${h.schemaName}".area_dataset WHERE id=$1`, [dataset]))
      .rejects.toMatchObject({ code: "23001" });
    await expect(h.pool.query(`DELETE FROM "${h.schemaName}".area_region WHERE id=$1`, [parent]))
      .rejects.toMatchObject({ code: "23001" });
  });
});

it("reads migrated rows through Drizzle with original strings and documented defaults", async () => {
  await withHarness(async h => {
    const datasetId = await h.seedDataset(); await h.seedRegion(datasetId, province);
    const tables = createAreaTables(h.schemaName);
    const db = drizzle(h.pool);
    const [dataset] = await db.select().from(tables.dataset);
    const [region] = await db.select().from(tables.region);
    expect(dataset).toMatchObject({ id: datasetId, source: "synthetic-test-only", status: "importing",
      isActive: false, importedAt: null, levelCounts: {}, importProgress: {}, importReport: {}, dataAsOf: "2000-01-01" });
    expect(region).toMatchObject({ code: "01", sourceName: " 合成省 ", displayName: null,
      sort: 0, enabled: true, revision: 1, parentId: null });
    expect(region?.createdAt).toBeInstanceOf(Date);
    expect(region?.updatedAt).toBeInstanceOf(Date);
  });
});

it("creates exactly two tables with matching Drizzle columns, checks, foreign keys and indexes", async () => {
  await withHarness(async h => {
    const tables = createAreaTables(h.schemaName);
    const found = await h.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [h.schemaName]);
    expect(found.rows.map(r => r.tablename)).toEqual(["area_dataset", "area_region"]);
    for (const table of [tables.dataset, tables.region]) {
      const config = getTableConfig(table);
      const columns = await h.pool.query(`SELECT column_name, is_nullable, udt_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [h.schemaName, config.name]);
      expect(columns.rows.map(r => [r.column_name, r.is_nullable])).toEqual(
        config.columns.map(c => [c.name, c.notNull ? "NO" : "YES"]));
      const types: Record<string, string> = { "timestamp with time zone": "timestamptz", "integer": "int4", "smallint": "int2", "boolean": "bool" };
      expect(columns.rows.map(r => r.udt_name)).toEqual(config.columns.map(c => types[c.getSQLType()] ?? c.getSQLType()));
      const constraints = await h.pool.query(`SELECT conname, contype, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid=$1::regclass`, [`"${h.schemaName}".${config.name}`]);
      const checkNames = constraints.rows.filter(r => r.contype === "c").map(r => r.conname).sort();
      expect(checkNames).toEqual(config.checks.map(c => c.name).sort());
      // Ask PostgreSQL to canonicalize each Drizzle check before comparing with the migration.
      for (const check of config.checks) {
        const rendered = new PgDialect().sqlToQuery(check.value);
        expect(rendered.params).toEqual([]);
        await h.pool.query(`ALTER TABLE "${h.schemaName}"."${config.name}" ADD CONSTRAINT equivalence_probe CHECK (${rendered.sql}) NOT VALID`);
        try {
          const probe = await h.pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conrelid=$1::regclass AND conname='equivalence_probe'`, [`"${h.schemaName}".${config.name}`]);
          expect(probe.rows[0].definition.replace(/ NOT VALID$/, ""))
            .toBe(constraints.rows.find(r => r.conname === check.name)!.definition);
        } finally {
          await h.pool.query(`ALTER TABLE "${h.schemaName}"."${config.name}" DROP CONSTRAINT equivalence_probe`);
        }
      }
      expect(constraints.rows.filter(r => r.contype === "f").map(r => r.conname).sort())
        .toEqual(config.foreignKeys.map(f => f.getName()).sort());
      for (const fk of constraints.rows.filter(r => r.contype === "f")) expect(fk.definition).toContain("ON DELETE RESTRICT");
      const indexes = await h.pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2", [h.schemaName, config.name]);
      const names = indexes.rows.map(r => r.indexname);
      expect(names.sort()).toEqual([
        ...config.columns.filter(c => c.primary).map(() => `${config.name}_pkey`),
        ...config.uniqueConstraints.map(c => c.name), ...config.indexes.map(i => i.config.name),
      ].sort());
      for (const index of config.indexes) {
        const actual = indexes.rows.find(r => r.indexname === index.config.name)!.indexdef;
        if (index.config.name === "area_dataset_one_active") {
          expect(actual).toContain("UNIQUE INDEX"); expect(actual).toContain("((1)) WHERE is_active");
          expect(new PgDialect().sqlToQuery(index.config.where!).sql).toContain('"is_active"');
        } else {
          const names = index.config.columns.map(c => "name" in c ? c.name : "SQL expression");
          expect(names).toEqual(index.config.name === "area_region_parent_sort_code"
            ? ["dataset_id", "parent_id", "sort", "code"] : ["dataset_id", "level", "sort", "code"]);
          expect(actual).toContain(`(${names.join(", ")})`);
        }
      }
    }
    const nonNull = await h.pool.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=$1 AND is_nullable='YES' ORDER BY table_name,column_name`, [h.schemaName]);
    expect(nonNull.rows).toEqual([
      { table_name: "area_dataset", column_name: "imported_at" },
      { table_name: "area_region", column_name: "display_name" },
      { table_name: "area_region", column_name: "parent_id" },
    ]);
  });
});

it("validates schema identifiers before SQL generation and handles public explicitly", () => {
  for (const name of ["", "Public", "1schema", "a.b", "example\n", "example\r", 'x";DROP SCHEMA public;--', "a".repeat(64)]) {
    expect(() => createAreaTables(name)).toThrow(); expect(() => areaMigrationSql(name)).toThrow();
  }
  expect(getTableConfig(createAreaTables().dataset).schema).toBeUndefined();
  expect(getTableConfig(createAreaTables("public").region).schema).toBeUndefined();
  expect(getTableConfig(createAreaTables("a".repeat(63)).dataset).schema).toBe("a".repeat(63));
  expect(areaMigrationSql()).toBe(areaMigrationSql("public"));
});


it("rejects null for every required dataset and region column", async () => {
  await withHarness(async h => {
    const datasetId = await h.seedDataset(); const regionId = await h.seedRegion(datasetId, province);
    const required: Record<string, string[]> = {
      area_dataset: ["id", "version_code", "source", "source_commit", "rules_version", "code_scheme", "data_as_of",
        "source_published_at", "file_checksums", "coverage", "level_counts", "status", "is_active", "import_progress",
        "import_report", "created_at", "updated_at"],
      area_region: ["id", "dataset_id", "code", "source_name", "level", "node_kind", "sort", "enabled", "revision",
        "created_at", "updated_at"],
    };
    for (const [table, columns] of Object.entries(required)) {
      for (const column of columns) {
        await expect(h.pool.query(`UPDATE "${h.schemaName}"."${table}" SET "${column}"=NULL WHERE id=$1`,
          [table === "area_dataset" ? datasetId : regionId])).rejects.toMatchObject({ code: "23502" });
      }
    }
  });
});

it("receives no ambient PostgreSQL settings and keeps its isolated connection writable", async () => {
  expect(Object.keys(process.env).filter(key => /^PG/i.test(key))).toEqual([]);
  expect(process.env.DATABASE_URL).toBeUndefined();
  expect(process.env.AREA_KIT_DATABASE_URL).toBeUndefined();
  await withHarness(async h => {
    const result = await h.pool.query("SHOW default_transaction_read_only");
    expect(result.rows[0].default_transaction_read_only).toBe("off");
    await expect(h.seedDataset()).resolves.toEqual(expect.any(String));
  });
});
