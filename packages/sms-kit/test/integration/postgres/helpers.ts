import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

export async function startPostgres(): Promise<{
  pool: Pool;
  stop(): Promise<void>;
}> {
  const container: StartedTestContainer = await new GenericContainer("postgres:17-alpine")
    .withEnvironment({ POSTGRES_DB: "sms_kit_test", POSTGRES_PASSWORD: "test", POSTGRES_USER: "test" })
    .withExposedPorts(5432)
    .withTmpFs({ "/var/lib/postgresql/data": "rw" })
    .start();
  const pool = new Pool({
    database: "sms_kit_test",
    host: container.getHost(),
    password: "test",
    port: container.getMappedPort(5432),
    user: "test",
  });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await pool.query("select 1");
      break;
    } catch (error) {
      if (attempt === 89) {
        await pool.end();
        await container.stop();
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return {
    pool,
    async stop(): Promise<void> {
      await pool.end();
      await container.stop();
    },
  };
}

export async function columnIsNotNull(pool: Pool, table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_nullable: "YES" | "NO" }>(
    `select is_nullable
       from information_schema.columns
      where table_schema = 'sms_kit' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows[0]?.is_nullable === "NO";
}

export async function allRequiredConstraintsExist(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ constraint_name: string }>(
    `select constraint_name
       from information_schema.table_constraints
      where table_schema = 'sms_kit'`,
  );
  const constraints = new Set(rows.map((row) => row.constraint_name));
  return [
    "send_message_tenant_id_idempotency_key_key",
    "send_attempt_message_id_attempt_no_key",
    "send_attempt_dispatch_token_key",
    "delivery_receipt_dedupe_key_key",
    "send_job_tenant_id_job_type_dedupe_key_key",
    "daily_stat_pkey",
    "daily_send_budget_pkey",
    "send_budget_reservation_message_id_key",
  ].every((name) => constraints.has(name)) && (await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'sms_kit' and indexname = 'otp_challenge_proof_hash_key'`,
  )).rows.length === 1;
}
