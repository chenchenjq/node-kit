#!/usr/bin/env node
/**
 * 一次性 PostgreSQL 集成测试入口：自建容器 → 跑 vitest.postgres.config.ts → 销毁容器。
 * 连接参数只通过子进程环境变量传递，且剥离宿主的 PG 系列变量与 DATABASE_URL，避免误连真实库。
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GenericContainer, Wait } from "testcontainers";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const VITEST_ENTRY = join(PACKAGE_ROOT, "..", "..", "node_modules", "vitest", "vitest.mjs");
const AREA_KIT_DIST = join(PACKAGE_ROOT, "..", "area-kit", "dist", "server", "index.js");
if (!existsSync(AREA_KIT_DIST)) {
  console.error("[verify-postgres] 需要先构建 area-kit：npm run build --workspace packages/area-kit");
  process.exit(1);
}
const IMAGE = "postgres@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7";
const DB = "area_parse_kit_ephemeral_test";
const USER = "isolated-test-only";

function childEnvironment(config) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const name = key.toUpperCase();
      return !name.startsWith("PG") && name !== "DATABASE_URL" && name !== "ADDR_PARSE_KIT_TEST_POSTGRES" && name !== "AREA_KIT_DATABASE_URL";
    }),
  );
  return { ...inherited, ADDR_PARSE_KIT_TEST_POSTGRES: JSON.stringify(config) };
}

async function runVitest(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VITEST_ENTRY, "run", "--config", "vitest.postgres.config.ts", ...process.argv.slice(2)], {
      cwd: PACKAGE_ROOT,
      env: childEnvironment(config),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

// 与 area-kit 集成测试同一镜像与同一临时盘策略：数据不落宿主机，销毁即消失。
const container = await new GenericContainer(IMAGE)
  .withName(`addr-parse-kit-test-${randomUUID()}`)
  .withEnvironment({ POSTGRES_USER: USER, POSTGRES_PASSWORD: USER, POSTGRES_DB: DB })
  .withTmpFs({ "/var/lib/postgresql": "rw" })
  .withExposedPorts(5432)
  .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
  .withStartupTimeout(180_000)
  .start();

try {
  process.exitCode = await runVitest({
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user: USER,
    password: USER,
    database: DB,
    containerId: container.getId(),
  });
} finally {
  await container.stop();
}
