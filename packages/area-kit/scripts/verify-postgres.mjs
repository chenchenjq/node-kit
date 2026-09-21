import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { postgresTestEnvironment } from "./postgres-test-environment.mjs";
import { withPostgres } from "./with-postgres.mjs";

try {
  process.exitCode = await withPostgres((config) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)),
      "run", "--config", "vitest.postgres.config.ts", ...process.argv.slice(2),
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: postgresTestEnvironment(config),
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  }));
} catch (error) {
  console.error("Isolated area-kit PostgreSQL test run failed:", error);
  process.exitCode = 1;
}
