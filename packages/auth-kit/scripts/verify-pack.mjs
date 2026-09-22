import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
});
if (result.status !== 0) {
  throw new Error(result.stderr || "npm pack --dry-run failed");
}

const entries = JSON.parse(result.stdout)?.[0]?.files?.map((file) => file.path) ?? [];
const files = new Set(entries);
for (const required of [
  "package.json",
  "README.md",
  "AI-USAGE.md",
  "dist/types.js",
  "dist/types.d.ts",
  "dist/server/index.js",
  "dist/server/index.d.ts",
  "dist/react/index.js",
  "dist/react/index.d.ts",
]) {
  if (!files.has(required)) throw new Error(`Package is missing ${required}`);
}
for (const path of files) {
  if (path.startsWith("src/") || path.startsWith("test/") || path.startsWith("artifacts/") || path.startsWith("scripts/")) {
    throw new Error(`Private source or artifact leaked into package: ${path}`);
  }
}
console.log(`Verified auth-kit package contents (${files.size} files)`);
