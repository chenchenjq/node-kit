import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const run = promisify(execFile);
const { stdout } = await run("npm", ["pack", "--json", "--dry-run"], { cwd: new URL("..", import.meta.url) });
const packed = JSON.parse(stdout)[0];
const files = new Set(packed.files.map((file) => file.path));
for (const required of ["package.json", "README.md", "DATABASE.md", "AI-USAGE.md", "dist/index.js", "dist/server/index.js", "dist/postgres/index.js", "migrations/0001-sku-kit.sql", "examples/next/app/api/sku/route.ts"]) assert(files.has(required), `missing ${required} from package`);
assert(![...files].some((file) => file.startsWith("test/") || file.startsWith("src/")), "source or tests leaked into tarball");
console.log(`pack manifest verified (${files.size} files)`);
