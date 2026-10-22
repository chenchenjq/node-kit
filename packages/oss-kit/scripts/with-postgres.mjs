import { GenericContainer, Wait } from "testcontainers";
export async function withPostgres(work) {
  const container = await new GenericContainer("postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "isolated-test-only", POSTGRES_DB: "oss_kit_ephemeral_test" })
    .withTmpFs({ "/var/lib/postgresql": "rw" })
    .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2)).withStartupTimeout(120000).start();
  try { await work({ host: container.getHost(), port: container.getMappedPort(5432), user: "test", password: "isolated-test-only", database: "oss_kit_ephemeral_test" }); }
  finally { await container.stop(); }
}
