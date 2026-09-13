import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const source = join(packageRoot, "src", "postgres", "migrations");
const destination = join(packageRoot, "dist", "postgres", "migrations");

await mkdir(destination, { recursive: true });
for (const name of await readdir(source)) {
  if (name.endsWith(".sql")) await cp(join(source, name), join(destination, name));
}
