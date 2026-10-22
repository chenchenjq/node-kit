import { GenericContainer, Wait } from "testcontainers";
import { run } from "./run.mjs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const c = await new GenericContainer("postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6")
  .withEnvironment({
    POSTGRES_USER: "test",
    POSTGRES_PASSWORD: "isolated-test-only",
    POSTGRES_DB: "ai_kit_ephemeral_test",
  })
  .withTmpFs({ "/var/lib/postgresql": "rw" })
  .withExposedPorts(5432)
  .withWaitStrategy(
    Wait.forLogMessage("database system is ready to accept connections", 2),
  )
  .withStartupTimeout(120000)
  .start();
try {
  await run(
    "node",
    [fileURLToPath(import.meta.resolve("tsx/cli")), "scripts/postgres-smoke.ts"],
    root,
    {
      AI_KIT_TEST_POSTGRES: JSON.stringify({
        host: c.getHost(),
        port: c.getMappedPort(5432),
        user: "test",
        password: "isolated-test-only",
        database: "ai_kit_ephemeral_test",
      }),
    },
  );
} finally {
  await c.stop();
}
