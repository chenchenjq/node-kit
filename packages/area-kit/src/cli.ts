import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AreaKitError } from "./errors.js";
import { prepareSource } from "./source/prepare.js";

export async function runCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_[0] !== "prepare" || arguments_.length !== 3 || arguments_[1] !== "--dir" || !arguments_[2]) {
    throw new AreaKitError("INVALID_ARGUMENT");
  }
  const prepared = await prepareSource(resolve(arguments_[2]));
  process.stdout.write(`${JSON.stringify(prepared)}\n`);
}

async function main(): Promise<void> {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    const safe = error instanceof AreaKitError ? error : new AreaKitError("IMPORT_CONFLICT");
    process.stderr.write(`${JSON.stringify(safe.toJSON())}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
