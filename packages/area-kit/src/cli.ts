import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AreaKitError } from "./errors.js";
import { auditSource } from "./source/audit.js";
import { prepareSource } from "./source/prepare.js";

export async function runCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_[0] === "check") {
    const values = new Map<string, string>();
    for (let index = 1; index < arguments_.length; index += 2) {
      const key = arguments_[index], value = arguments_[index + 1];
      if ((key !== "--dir" && key !== "--report-dir") || !value || values.has(key)) throw new AreaKitError("INVALID_ARGUMENT");
      values.set(key, value);
    }
    if (!values.has("--dir") || !values.has("--report-dir")) throw new AreaKitError("INVALID_ARGUMENT");
    const audit = await auditSource(resolve(values.get("--dir")!), resolve(values.get("--report-dir")!));
    process.stdout.write(`${JSON.stringify(audit.report)}\n`);
    if (!audit.report.passed) process.exitCode = 1;
    return;
  }
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
