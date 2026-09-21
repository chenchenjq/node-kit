import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../core/errors.js";

type MigrationFile = Readonly<{ version: number; name: string; url: URL }>;

const migrationFiles: readonly MigrationFile[] = [
  { version: 1, name: "0001_initial.sql", url: new URL("./migrations/0001_initial.sql", import.meta.url) },
  { version: 2, name: "0002_reliability_policy.sql", url: new URL("./migrations/0002_reliability_policy.sql", import.meta.url) },
  { version: 3, name: "0003_receipt_ownership.sql", url: new URL("./migrations/0003_receipt_ownership.sql", import.meta.url) },
  { version: 4, name: "0004_query_receipt_out_id.sql", url: new URL("./migrations/0004_query_receipt_out_id.sql", import.meta.url) },
  { version: 5, name: "0005_challenge_security.sql", url: new URL("./migrations/0005_challenge_security.sql", import.meta.url) },
  { version: 6, name: "0006_challenge_delivery_acceptance.sql", url: new URL("./migrations/0006_challenge_delivery_acceptance.sql", import.meta.url) },
  { version: 7, name: "0007_admin_operation.sql", url: new URL("./migrations/0007_admin_operation.sql", import.meta.url) },
  { version: 8, name: "0008_signature_active_identity.sql", url: new URL("./migrations/0008_signature_active_identity.sql", import.meta.url) },
  { version: 9, name: "0009_admin_operations.sql", url: new URL("./migrations/0009_admin_operations.sql", import.meta.url) },
  { version: 10, name: "0010_admin_job_authorization.sql", url: new URL("./migrations/0010_admin_job_authorization.sql", import.meta.url) },
];

const bootstrapDdl = `
  CREATE SCHEMA IF NOT EXISTS sms_kit;
  CREATE TABLE IF NOT EXISTS sms_kit.schema_migration (
    version bigint PRIMARY KEY CHECK (version > 0),
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL
  );`;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function mapPgError(error: unknown): never {
  if (error instanceof SmsKitError) throw error;
  const causeCode = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
  throw new SmsKitError("STORAGE_FAILURE", "PostgreSQL migration failed", true, undefined, causeCode);
}

async function loadMigrations(): Promise<readonly (MigrationFile & { sql: string; checksum: string })[]> {
  return Promise.all(migrationFiles.map(async (migration) => {
    const sql = await readFile(migration.url, "utf8");
    return { ...migration, sql, checksum: checksum(sql) };
  }));
}

async function ensureMigrationLedger(client: PoolClient): Promise<void> {
  await client.query(bootstrapDdl);
}

async function verifyRecordedChecksums(
  client: PoolClient,
  migrations: readonly (MigrationFile & { sql: string; checksum: string })[],
): Promise<readonly number[]> {
  const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
    "select version, name, checksum from sms_kit.schema_migration order by version",
  );
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (migration === undefined || migration.version !== Number(row.version)) {
      throw new SmsKitError("STORAGE_FAILURE", "database migration ledger has a gap");
    }
    if (migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new SmsKitError("STORAGE_FAILURE", "database migration checksum mismatch");
    }
  }
  return rows.map((row) => Number(row.version));
}

async function normalizeLegacyV1Leases(client: PoolClient, appliedVersions: readonly number[]): Promise<void> {
  if (appliedVersions.length !== 1 || appliedVersions[0] !== 1) return;
  await client.query(`
    update sms_kit.send_message message
       set acceptance_status = 'unknown',
           delivery_status = case when delivery_status = 'not_applicable' then 'waiting' else delivery_status end,
           final_error_code = coalesce(final_error_code, 'ACCEPTANCE_UNKNOWN'),
           version = version + 1,
           updated_at = now()
      from sms_kit.send_job job
     where job.message_id = message.id
       and job.state = 'leased'
       and message.acceptance_status = 'pending';
    update sms_kit.send_job
       set state = 'dead',
           lease_owner = null,
           lease_until = null,
           last_error_code = coalesce(last_error_code, 'ACCEPTANCE_UNKNOWN'),
           updated_at = now()
     where state = 'leased';
  `);
}

async function applyMigrations(
  client: PoolClient,
  migrations: readonly (MigrationFile & { sql: string; checksum: string })[],
): Promise<void> {
  const { rows } = await client.query<{ version: string }>("select version from sms_kit.schema_migration");
  const applied = new Set(rows.map((row) => Number(row.version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await client.query(migration.sql);
    await client.query(
      "insert into sms_kit.schema_migration (version, name, checksum, applied_at) values ($1, $2, $3, now())",
      [migration.version, migration.name, migration.checksum],
    );
  }
}

export async function migrateSmsKit(pool: Pool): Promise<void> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('sms-kit-migrate'))");
    await ensureMigrationLedger(client);
    const appliedVersions = await verifyRecordedChecksums(client, migrations);
    await normalizeLegacyV1Leases(client, appliedVersions);
    await applyMigrations(client, migrations);
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The original error remains the actionable one.
    }
    mapPgError(error);
  } finally {
    client.release();
  }
}

export async function getSmsKitSchemaVersion(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ version: string }>(
    "select coalesce(max(version), 0)::text as version from sms_kit.schema_migration",
  );
  return Number(rows[0]?.version ?? "0");
}
