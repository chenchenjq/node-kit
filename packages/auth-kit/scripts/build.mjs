import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src");
const output = resolve(root, "dist");
const staging = resolve(root, ".dist-build");

for (const entry of ["types.js", "types.d.ts", "server/index.js", "server/index.d.ts", "react/index.js", "react/index.d.ts"]) {
  if (!existsSync(resolve(source, entry))) {
    throw new Error(`Missing auth-kit source entry: ${entry}`);
  }
}

rmSync(staging, { recursive: true, force: true });
try {
  cpSync(source, staging, { recursive: true });
  rmSync(output, { recursive: true, force: true });
  renameSync(staging, output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
