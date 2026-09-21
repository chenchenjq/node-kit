import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("removes ambient PostgreSQL settings from the real child environment and effective pg config", async () => {
  const { postgresTestEnvironment } = await import(new URL("../scripts/postgres-test-environment.mjs", import.meta.url).href);
  const config = { host: "127.0.0.1", port: 54321, user: "isolated-test-only", password: "isolated-test-only",
    database: "area_kit_ephemeral_test", containerId: "a".repeat(64) };
  const ambient = { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on", PGSSLNEGOTIATION: "direct",
    PGSSLMODE: "require", PGBINARY: "1", PGREPLICATION: "database", PGCLIENT_ENCODING: "SQL_ASCII",
    PGHOST: "forbidden.invalid", PGPORT: "1", PGDATABASE: "production", PGUSER: "ambient-user",
    PGPASSWORD: "synthetic-ambient-password", PGSERVICE: "ambient-service", PGSERVICEFILE: "/forbidden/service",
    PGPASSFILE: "/forbidden/password", PGAPPNAME: "ambient-app", PGCONNECT_TIMEOUT: "1",
    DATABASE_URL: "postgres://forbidden.invalid/production", AREA_KIT_DATABASE_URL: "postgres://forbidden.invalid/production",
    AREA_KIT_TEST_POSTGRES: "forbidden-ambient-config", NODE_NO_WARNINGS: "1", TEST_APP_SETTING: "preserved" };
  const environment = postgresTestEnvironment(config, ambient);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import pg from "pg";
    const config = JSON.parse(process.env.AREA_KIT_TEST_POSTGRES);
    const client = new pg.Client({ ...config, ssl: false, connectionTimeoutMillis: 5000 });
    const effective = client.connectionParameters;
    console.log(JSON.stringify({
      pgKeys: Object.keys(process.env).filter(key => /^PG/i.test(key)),
      databaseUrl: process.env.DATABASE_URL ?? null, appDatabaseUrl: process.env.AREA_KIT_DATABASE_URL ?? null,
      nodeSetting: process.env.NODE_NO_WARNINGS, appSetting: process.env.TEST_APP_SETTING, path: process.env.PATH,
      config, host: effective.host, database: effective.database, options: effective.options ?? null,
      ssl: effective.ssl, sslnegotiation: effective.sslnegotiation ?? null,
      replication: effective.replication ?? null, binary: effective.binary,
    }));
  `], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: environment, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ pgKeys: [], databaseUrl: null, appDatabaseUrl: null,
    nodeSetting: "1", appSetting: "preserved", path: process.env.PATH, config,
    host: "127.0.0.1", database: "area_kit_ephemeral_test", options: null, ssl: false,
    sslnegotiation: null, replication: null, binary: false });
  expect(ambient.PGOPTIONS).toBe("-c default_transaction_read_only=on");
  expect(ambient.AREA_KIT_TEST_POSTGRES).toBe("forbidden-ambient-config");
});
