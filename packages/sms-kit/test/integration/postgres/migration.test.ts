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
    await expect(getSmsKitSchemaVersion(pool)).resolves.toBe(2);
  }, 60_000);

  it("upgrades the fixed previous-version fixture", async () => {
    const { pool } = postgres;
    await pool.query(await readFile(previousSchemaFixture, "utf8"));
    await migrateSmsKit(pool);
    await expect(getSmsKitSchemaVersion(pool)).resolves.toBe(2);
    await migrateSmsKit(pool);
    await expect(allRequiredConstraintsExist(pool)).resolves.toBe(true);
  }, 60_000);

  it("rejects an applied migration whose checksum changed", async () => {
    const { pool } = postgres;
    await migrateSmsKit(pool);
    await pool.query("update sms_kit.schema_migration set checksum = 'tampered' where version = 1");
    await expect(migrateSmsKit(pool)).rejects.toThrow("checksum");
  }, 60_000);
});
