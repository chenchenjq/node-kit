import { resolve, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { AreaKitError } from "./errors.js";

/** Schema is an operator-supplied identifier, never SQL or an HTTP parameter. */
async function schemaOption(values: ReadonlyMap<string, string>): Promise<string> {
  const schemaName = values.get("--schema") ?? "public";
  const { validateSchemaName } = await import("./postgres/schema-name.js");
  validateSchemaName(schemaName);
  return schemaName;
}

export async function runCli(arguments_: readonly string[]): Promise<void> {
  const command = arguments_[0];
  if (command === "activate") {
    const values = new Map<string, string>();
    for (let index = 1; index < arguments_.length; index++) {
      const key = arguments_[index]!, value = arguments_[++index];
      if ((key !== "--dataset-id" && key !== "--schema") || !value?.trim() || value.startsWith("--") || values.has(key)) {
        throw new AreaKitError("INVALID_ARGUMENT");
      }
      values.set(key, value);
    }
    const datasetId = values.get("--dataset-id");
    if (!datasetId) throw new AreaKitError("INVALID_ARGUMENT");
    const schemaName = await schemaOption(values);
    if (!process.env.AREA_KIT_DATABASE_URL?.trim()) throw new AreaKitError("INVALID_CONFIG");
    const [{Pool},{createDrizzleAreaStore},{activateDataset}] = await Promise.all([
      import("pg"), import("./postgres/store.js"), import("./import/activate.js"),
    ]);
    const pool = new Pool({connectionString:process.env.AREA_KIT_DATABASE_URL,connectionTimeoutMillis:10_000});
    try {
      const dataset = await activateDataset(createDrizzleAreaStore(pool, {schemaName}),datasetId);
      process.stdout.write(`${JSON.stringify(dataset)}\n`);
    } finally { await pool.end(); }
    return;
  }
  if (command === "check" || command === "import") {
    const values = new Map<string, string>();
    let activate = false;
    for (let index = 1; index < arguments_.length; index++) {
      const key = arguments_[index]!;
      if (command === "import" && key === "--activate") {
        if (activate) throw new AreaKitError("INVALID_ARGUMENT");
        activate = true;
        continue;
      }
      const value = arguments_[++index];
      if ((key !== "--dir" && key !== "--report-dir" && !(command === "import" &&
          (key === "--batch-size" || key === "--inherit-from" || key === "--schema"))) || !value?.trim() || value.startsWith("--") || values.has(key)) {
        throw new AreaKitError("INVALID_ARGUMENT");
      }
      values.set(key,value);
    }
    if (!values.has("--dir") || !values.has("--report-dir")) throw new AreaKitError("INVALID_ARGUMENT");
    let batchSize = 1000;
    let schemaName = "public";
    if (command === "import") {
      batchSize = values.has("--batch-size") ? Number(values.get("--batch-size")) : 1000;
      const { assertBatchSize } = await import("./import/runner.js");
      assertBatchSize(batchSize);
      schemaName = await schemaOption(values);
      if (!process.env.AREA_KIT_DATABASE_URL?.trim()) throw new AreaKitError("INVALID_CONFIG");
    }
    const { auditSource } = await import("./source/audit.js");
    const progress = (message: string) => process.stderr.write(`[area-kit] ${message}\n`);
    const started = performance.now();
    const audit = await auditSource(resolve(values.get("--dir")!), resolve(values.get("--report-dir")!), undefined, (level, count) => progress(`audit level ${level}: ${count} verified`));
    progress(`source audit elapsedMs=${Math.round(performance.now() - started)}`);
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
        const inheritFromDatasetId = values.get("--inherit-from");
        let dataset = await importAuditedSource(createPostgresImportBackend(pool, {schemaName}), audit, {
          batchSize, onProgress: progress, ...(inheritFromDatasetId === undefined ? {} : {inheritFromDatasetId}),
        });
        if (activate) {
          const [{createDrizzleAreaStore},{activateDataset}] = await Promise.all([
            import("./postgres/store.js"),import("./import/activate.js"),
          ]);
          dataset = await activateDataset(createDrizzleAreaStore(pool, {schemaName}),dataset.datasetId);
        }
        progress(`completed elapsedMs=${Math.round(performance.now() - started)} peakRssKiB=${process.resourceUsage().maxRSS}`);
        process.stdout.write(`${JSON.stringify(dataset)}\n`);
      } finally { await pool.end(); }
    }
    return;
  }
  if (arguments_[0] !== "prepare" || arguments_.length !== 3 || arguments_[1] !== "--dir" || !arguments_[2]) {
    throw new AreaKitError("INVALID_ARGUMENT");
  }
  const { prepareSource } = await import("./source/prepare.js");
  const started = performance.now();
  const prepared = await prepareSource(resolve(arguments_[2]));
  const measurement = {
    elapsedMs: performance.now() - started,
    peakRssKiB: process.resourceUsage().maxRSS,
    mode: "prepareSource: verify cached files and download missing files",
    completedAt: new Date().toISOString(),
  };
  await writeFile(join(prepared.directory, "preparation-measurement.json"), JSON.stringify(measurement, null, 2) + "\n");
  process.stderr.write(`[area-kit] source preparation elapsedMs=${Math.round(measurement.elapsedMs)} peakRssKiB=${measurement.peakRssKiB}\n`);
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
