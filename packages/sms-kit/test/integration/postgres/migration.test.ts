import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSmsKitSchemaVersion, migrateSmsKit } from "../../../src/postgres/index.js";
import { allRequiredConstraintsExist, columnIsNotNull, startPostgres } from "./helpers.js";

const previousSchemaFixture = fileURLToPath(new URL("../../fixtures/postgres/0000_previous.sql", import.meta.url));

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
      "audit_event", "daily_send_budget", "daily_stat", "delivery_receipt",
      "otp_challenge", "policy_config", "provider_config", "rate_limit_bucket",
      "resource_sync", "resource_sync_candidate", "schema_migration",
      "send_attempt", "send_budget_reservation", "send_job", "send_message",
      "signature", "stat_dirty_date", "template",
    ]);
    await expect(columnIsNotNull(pool, "send_message", "tenant_id")).resolves.toBe(true);
    await expect(columnIsNotNull(pool, "otp_challenge", "tenant_id")).resolves.toBe(true);
    await expect(getSmsKitSchemaVersion(pool)).resolves.toBe(3);
  }, 60_000);

  it("upgrades the fixed previous-version fixture", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousSchemaFixture, "utf8"));
    await migrateSmsKit(pool);
    await expect(getSmsKitSchemaVersion(pool)).resolves.toBe(3);
    await migrateSmsKit(pool);
    await expect(allRequiredConstraintsExist(pool)).resolves.toBe(true);
  }, 60_000);

  it("upgrades an old v2 leased job without making a stale dispatch retryable", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousSchemaFixture, "utf8"));
    await pool.query(`insert into sms_kit.send_job (id, tenant_id, dedupe_key, job_type, state, available_at, lease_owner, lease_token, lease_until, attempt_count, max_attempts, payload, created_at, updated_at)
      values ('00000000-0000-4000-8000-000000000001', 'tenant-v2', 'v2-leased', 'send', 'leased', now(), 'old-worker', '00000000-0000-4000-8000-000000000002', now() + interval '1 hour', 1, 3, '{"kind":"none"}', now(), now())`);

    await migrateSmsKit(pool);

    await expect(pool.query<{ state: string; lease_token: string | null; last_error_code: string | null }>("select state, lease_token, last_error_code from sms_kit.send_job where dedupe_key = 'v2-leased'"))
      .resolves.toMatchObject({ rows: [{ state: "dead", lease_token: null, last_error_code: "ACCEPTANCE_UNKNOWN" }] });
  }, 60_000);

  it("rejects an arbitrary checksum in an old v2 migration ledger", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousSchemaFixture, "utf8"));
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
