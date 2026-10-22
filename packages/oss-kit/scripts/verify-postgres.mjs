import { fileURLToPath } from "node:url";
import { run } from "./run.mjs";
import { withPostgres } from "./with-postgres.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
await run("npm", ["run", "build"], root);
await withPostgres(connection => run("node", [fileURLToPath(import.meta.resolve("tsx/cli")), "scripts/postgres-smoke.ts"], root, { OSS_KIT_TEST_POSTGRES: JSON.stringify(connection) }));
