import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { CanonicalRow } from "../../src/source/audit.js";
import type { DatasetSummary } from "../../src/types.js";
import { areaMigrationSql } from "../../src/postgres/migration.js";
import { isolatedPostgresConfig } from "./config.js";

export interface PgHarness {
  pool: Pool;
  schemaName: string;
  seedDataset(options?: {status?: DatasetSummary["status"]; isActive?: boolean; versionCode?: string}): Promise<string>;
  seedRegion(datasetId: string, row: CanonicalRow, parentId?: string | null): Promise<string>;
  close(): Promise<void>;
}

export async function createPgHarness(): Promise<PgHarness> {
  const pool = new Pool(isolatedPostgresConfig());
  const schemaName = `area_test_${randomUUID().replaceAll("-", "")}`;
  let schemaCreated = false;
  try {
    const identity = await pool.query("SELECT current_database() AS database, current_user AS username");
    if (identity.rows[0].database !== "area_kit_ephemeral_test" || identity.rows[0].username !== "isolated-test-only") {
      throw new Error("Refusing non-ephemeral PostgreSQL connection");
    }
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
    await pool.query(areaMigrationSql(schemaName));
  } catch (error) {
    try { if (schemaCreated) await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`); }
    finally { await pool.end(); }
    throw error;
  }
  return {
    pool, schemaName,
    async seedDataset(options = {}) {
      const id = randomUUID();
      const status = options.status ?? "importing";
      await pool.query(`INSERT INTO "${schemaName}".area_dataset
        (id, version_code, source, source_commit, rules_version, code_scheme, data_as_of,
         source_published_at, file_checksums, coverage, level_counts, status, is_active,
         import_progress, import_report, imported_at)
        VALUES ($1,$2,'synthetic-test-only','synthetic-commit','synthetic-rules-v1','synthetic-codes',
          '2000-01-01','2000-01-02',$3,$4,'{}',$5,$6,'{}','{}',$7)`,
      [id, options.versionCode ?? `synthetic-test-only:${id}:synthetic-rules-v1`,
        JSON.stringify([{ name: "synthetic.csv", path: "synthetic.csv", level: 1, bytes: 0, sha256: "synthetic-test-checksum" }]),
        JSON.stringify({ levels: [1,2,3,4,5], excluded: [], description: "synthetic-test-only" }),
        status, options.isActive ?? false, status === "ready" ? new Date() : null]);
      return id;
    },
    async seedRegion(datasetId, row, parentId = null) {
      const id = randomUUID();
      await pool.query(`INSERT INTO "${schemaName}".area_region
        (id,dataset_id,code,source_name,level,parent_id,node_kind) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id,datasetId,row.code,row.sourceName,row.level,parentId,row.nodeKind]);
      return id;
    },
    async close() {
      try { await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`); }
      finally { await pool.end(); }
    },
  };
}
