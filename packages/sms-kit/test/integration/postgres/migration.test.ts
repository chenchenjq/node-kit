import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSmsKitSchemaVersion, migrateSmsKit } from "../../../src/postgres/index.js";
import { allRequiredConstraintsExist, columnIsNotNull, startPostgres } from "./helpers.js";

const previousV1SchemaFixture = fileURLToPath(new URL("../../fixtures/postgres/0001_previous.sql", import.meta.url));
const previousV2SchemaFixture = fileURLToPath(new URL("../../fixtures/postgres/0000_previous.sql", import.meta.url));

async function seedPendingDeliveredLease(pool: Pool, version: 1 | 2): Promise<void> {
  const tenantId = `tenant-v${version}`;
  await pool.query(
    `insert into sms_kit.signature (id, external_key, external_name, external_status, external_type, imported_at, last_synced_at, created_at, updated_at)
     values ('00000000-0000-4000-8000-000000000010', $1, 'Legacy', 'approved', 'text', now(), now(), now(), now())`,
    [`sign:v${version}`],
  );
  await pool.query(
    `insert into sms_kit.template (id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, content_snapshot, variable_schema, imported_at, last_synced_at, created_at, updated_at)
     values ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010', $1, $2, 'Legacy', 'approved', 'notification', 'migration', '', '[]', now(), now(), now(), now())`,
    [`notice.v${version}`, `SMS_V${version}`],
  );
  await pool.query(
    `insert into sms_kit.send_message (id, tenant_id, idempotency_key, template_id, template_key_snapshot, external_template_code_snapshot, signature_name_snapshot, purpose, variable_names, acceptance_status, delivery_status, submitted_at, delivered_at, created_at, updated_at)
     values ('00000000-0000-4000-8000-000000000012', $1, $2, '00000000-0000-4000-8000-000000000011', $3, $4, 'Legacy', 'migration', '[]', 'pending', 'delivered', now(), now(), now(), now())`,
    [tenantId, `message:v${version}`, `notice.v${version}`, `SMS_V${version}`],
  );
  const columns = version === 1 ? "" : ", lease_token";
  const values = version === 1 ? "" : ", '00000000-0000-4000-8000-000000000014'";
  await pool.query(
    `insert into sms_kit.send_job (id, tenant_id, dedupe_key, job_type, message_id, state, available_at, lease_owner, lease_until, attempt_count, max_attempts, payload, created_at, updated_at${columns})
     values ('00000000-0000-4000-8000-000000000013', $1, $2, 'send', '00000000-0000-4000-8000-000000000012', 'leased', now(), 'old-worker', now() + interval '1 hour', 1, 3, '{"kind":"none"}', now(), now()${values})`,
    [tenantId, `v${version}-leased`],
  );
}

describe("sms-kit PostgreSQL migration", () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;

  beforeAll(async () => {
    postgres = await startPostgres();
  }, 120_000);

  beforeEach(async () => {
    await postgres.pool.query("drop schema if exists sms_kit cascade");
  }, 60_000);

  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it("creates the complete sms_kit schema idempotently", async () => {
    const { pool } = postgres;
    await migrateSmsKit(pool);
    await migrateSmsKit(pool);
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'sms_kit' order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      "admin_job_authorization", "admin_operation", "audit_event", "daily_send_budget", "daily_stat", "delivery_receipt",
      "otp_challenge", "policy_config", "provider_config", "rate_limit_bucket",
      "resource_sync", "resource_sync_candidate", "schema_migration",
      "send_attempt", "send_budget_reservation", "send_job", "send_message",
      "signature", "stat_dirty_date", "template",
    ]);
    await expect(columnIsNotNull(pool, "send_message", "tenant_id")).resolves.toBe(true);
    await expect(columnIsNotNull(pool, "otp_challenge", "tenant_id")).resolves.toBe(true);
    await expect(pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where schemaname = 'sms_kit' and indexname = 'signature_active_name_type_key'`,
    )).resolves.toMatchObject({ rows: [{ indexname: "signature_active_name_type_key" }] });
    await expect(pool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable
         from information_schema.columns
        where table_schema = 'sms_kit' and table_name = 'send_job' and column_name = 'origin_action'`,
    )).resolves.toMatchObject({ rows: [{ column_name: "origin_action", is_nullable: "YES" }] });
    await expect(pool.query<{ conname: string }>(
      `select conname from pg_constraint
        where connamespace = 'sms_kit'::regnamespace and conname = 'send_job_origin_action_check'`,
    )).resolves.toMatchObject({ rows: [{ conname: "send_job_origin_action_check" }] });
    await expect(pool.query(
      `insert into sms_kit.send_job (
         id, tenant_id, dedupe_key, job_type, state, available_at,
         attempt_count, max_attempts, origin_action, payload, created_at, updated_at
       ) values (
         '00000000-0000-4000-8000-000000000099', 'origin-check', 'invalid-origin-pair', 'send', 'pending', now(),
         0, 1, 'receipt.reconcile', '{"kind":"none"}'::jsonb, now(), now()
       )`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(getSmsKitSchemaVersion(pool)).resolves.toBe(10);
  }, 60_000);

  it("upgrades the fixed previous-version fixture", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousV2SchemaFixture, "utf8"));
    await migrateSmsKit(pool);
    await expect(getSmsKitSchemaVersion(pool)).resolves.toBe(10);
    await migrateSmsKit(pool);
    await expect(allRequiredConstraintsExist(pool)).resolves.toBe(true);
  }, 60_000);

  it("upgrades a v1 lease before immutable migration 0002 validates lease state", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousV1SchemaFixture, "utf8"));
    await seedPendingDeliveredLease(pool, 1);

    await migrateSmsKit(pool);

    await expect(getSmsKitSchemaVersion(pool)).resolves.toBe(10);
    await expect(pool.query<{ state: string; lease_token: string | null; last_error_code: string | null }>("select state, lease_token, last_error_code from sms_kit.send_job where dedupe_key = 'v1-leased'"))
      .resolves.toMatchObject({ rows: [{ state: "dead", lease_token: null, last_error_code: "ACCEPTANCE_UNKNOWN" }] });
    await expect(pool.query<{ acceptance_status: string; delivery_status: string }>("select acceptance_status, delivery_status from sms_kit.send_message where id = '00000000-0000-4000-8000-000000000012'"))
      .resolves.toMatchObject({ rows: [{ acceptance_status: "unknown", delivery_status: "delivered" }] });
  }, 60_000);

  it("upgrades an old v2 lease without overwriting terminal delivery", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousV2SchemaFixture, "utf8"));
    await seedPendingDeliveredLease(pool, 2);

    await migrateSmsKit(pool);

    await expect(pool.query<{ state: string; lease_token: string | null; last_error_code: string | null }>("select state, lease_token, last_error_code from sms_kit.send_job where dedupe_key = 'v2-leased'"))
      .resolves.toMatchObject({ rows: [{ state: "dead", lease_token: null, last_error_code: "ACCEPTANCE_UNKNOWN" }] });
    await expect(pool.query<{ acceptance_status: string; delivery_status: string }>("select acceptance_status, delivery_status from sms_kit.send_message where id = '00000000-0000-4000-8000-000000000012'"))
      .resolves.toMatchObject({ rows: [{ acceptance_status: "unknown", delivery_status: "delivered" }] });
  }, 60_000);

  it("rejects an arbitrary checksum in an old v2 migration ledger", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousV2SchemaFixture, "utf8"));
    await pool.query("update sms_kit.schema_migration set checksum = 'tampered' where version = 2");
    await expect(migrateSmsKit(pool)).rejects.toThrow("checksum");
  }, 60_000);

  it("rejects a ledger with a missing earlier migration", async () => {
    const { pool } = postgres;
    await migrateSmsKit(pool);
    await pool.query("delete from sms_kit.schema_migration where version = 1");

    await expect(migrateSmsKit(pool)).rejects.toMatchObject({
      code: "STORAGE_FAILURE",
      message: "database migration ledger has a gap",
    });
  }, 60_000);
});
