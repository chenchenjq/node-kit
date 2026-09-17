import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AreaKitError } from "./errors.js";

export async function runCli(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0];
  if (command === "check" || command === "import") {
    const values = new Map<string, string>();
    for (let index = 1; index < arguments_.length; index += 2) {
      const key = arguments_[index], value = arguments_[index + 1];
      if ((key !== "--dir" && key !== "--report-dir" && !(command === "import" && key === "--batch-size")) || !value || values.has(key)) throw new AreaKitError("INVALID_ARGUMENT");
      values.set(key, value);
    }
    if (!values.has("--dir") || !values.has("--report-dir")) throw new AreaKitError("INVALID_ARGUMENT");
    let batchSize = 1000;
    if (command === "import") {
      batchSize = values.has("--batch-size") ? Number(values.get("--batch-size")) : 1000;
      const { assertBatchSize } = await import("./import/runner.js");
      assertBatchSize(batchSize);
      if (!process.env.AREA_KIT_DATABASE_URL?.trim()) throw new AreaKitError("INVALID_CONFIG");
    }
    const { auditSource } = await import("./source/audit.js");
    const audit = await auditSource(resolve(values.get("--dir")!), resolve(values.get("--report-dir")!));
    if (command === "check") {
      process.stdout.write(`${JSON.stringify(audit.report)}\n`);
      if (!audit.report.passed) process.exitCode = 1;
    } else {
      if (!audit.report.passed) throw new AreaKitError("IMPORT_CONFLICT");
      const [{ Pool }, { createPostgresImportBackend }, { importAuditedSource }] = await Promise.all([
        import("pg"), import("./postgres/import-backend.js"), import("./import/runner.js"),
      ]);
      const pool = new Pool({ connectionString: process.env.AREA_KIT_DATABASE_URL, connectionTimeoutMillis: 10_000 });
      try {
        const dataset = await importAuditedSource(createPostgresImportBackend(pool), audit, {batchSize});
        process.stdout.write(`${JSON.stringify(dataset)}\n`);
      } finally { await pool.end(); }
    }
    return;
  }
  if (arguments_[0] !== "prepare" || arguments_.length !== 3 || arguments_[1] !== "--dir" || !arguments_[2]) {
    throw new AreaKitError("INVALID_ARGUMENT");
  }
  const { prepareSource } = await import("./source/prepare.js");
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
