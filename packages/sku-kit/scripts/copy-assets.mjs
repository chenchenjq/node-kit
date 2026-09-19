import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(packageRoot, "migrations");
const destination = join(packageRoot, "dist", "migrations");

try {
  await stat(source);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}
