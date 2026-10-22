import { randomUUID } from "node:crypto";
import { GenericContainer, Wait } from "testcontainers";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { postgresTestEnvironment } from "./postgres-test-environment.mjs";

const runFile = promisify(execFile);

const IMAGE = "postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6";

/** All connection details originate from this newly started, disposable container. */
export async function withPostgres(run) {
  const container = await new GenericContainer(IMAGE)
    .withName(`area-kit-test-${randomUUID()}`)
    .withEnvironment({
      POSTGRES_USER: "isolated-test-only",
      POSTGRES_PASSWORD: "isolated-test-only",
      POSTGRES_DB: "area_kit_ephemeral_test",
    })
    // Disposable test data avoids host-disk initdb fsync stalls and never persists.
    .withTmpFs({ "/var/lib/postgresql": "rw" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(180_000)
    .start();
  try {
    const config = {
      host: container.getHost(), port: container.getMappedPort(5432),
      user: "isolated-test-only", password: "isolated-test-only",
      database: "area_kit_ephemeral_test", containerId: container.getId(),
    };
    // pg also reads PGOPTIONS, PGSSLNEGOTIATION, etc. at client construction.
    // Use a clean child environment without mutating the caller's process.env.
    await runFile(process.execPath, ["--input-type=module", "-e", `
      import pg from "pg";
      const config = JSON.parse(process.env.AREA_KIT_TEST_POSTGRES);
      const pool = new pg.Pool({ ...config, ssl: false, connectionTimeoutMillis: 5000 });
      try { await pool.query("SELECT 1"); } finally { await pool.end(); }
    `], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: postgresTestEnvironment(config),
      timeout: 15_000,
    });
    return await run(config);
  } finally {
    await container.stop();
  }
}
