import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, {recursive:true,force:true}))); });
async function run(args: string[], env: NodeJS.ProcessEnv) {
  return exec(process.execPath, ["--import", "tsx", cli, ...args], {env}).catch(error => error as {stdout:string;stderr:string;code:number});
}
it("accepts import options and reports missing connection configuration safely", async () => {
  const env = {...process.env}; delete env.AREA_KIT_DATABASE_URL;
  const result = await run(["import","--dir","/unused","--report-dir","/unused-report","--batch-size","2"], env);
  expect(JSON.parse(result.stderr).code).toBe("INVALID_CONFIG");
});
it.each(["0","5001","1.2","NaN","2x"])("validates import batch size %s before loading a connection", async value => {
  const env = {...process.env}; delete env.AREA_KIT_DATABASE_URL;
  const result = await run(["import","--dir","/unused","--report-dir","/unused-report","--batch-size",value], env);
  expect(JSON.parse(result.stderr).code).toBe("INVALID_ARGUMENT");
});
it("check works when database optional dependencies are blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(),"area-cli-no-db-")); dirs.push(directory);
  const loader = join(directory,"block-db.mjs");
  await writeFile(loader, `export async function resolve(specifier, context, next) {
    if (specifier === 'pg' || specifier.startsWith('drizzle-orm')) throw new Error('DATABASE_MODULE_LOADED');
    return next(specifier,context);
  }`);
  const env = {...process.env}; delete env.AREA_KIT_DATABASE_URL;
  const result = await exec(process.execPath, ["--no-warnings","--loader",loader,"--import","tsx",cli,"check","--dir",join(directory,"missing"),"--report-dir",join(directory,"audit")], {env}).catch(error => error);
  expect(result.stderr).not.toContain("DATABASE_MODULE_LOADED");
  expect(JSON.parse(result.stdout).passed).toBe(false);
});


it.each(["import", "activate"])("validates %s schema configuration before opening a connection", async command => {
  const base = command === "import" ? ["import", "--dir", "/unused", "--report-dir", "/unused-report"]
    : ["activate", "--dataset-id", "unused"];
  vi.stubEnv("AREA_KIT_DATABASE_URL", "postgres://must-not-connect.invalid/unused");
  try {
    for (const schema of ["public;drop schema public", "MixedCase", "tenant.schema", "a".repeat(64)]) {
      await expect(runCli([...base, "--schema", schema])).rejects.toMatchObject({code: "INVALID_CONFIG"});
    }
    for (const args of [["--schema"], ["--schema", ""], ["--schema", "one", "--schema", "two"]]) {
      await expect(runCli([...base, ...args])).rejects.toMatchObject({code: "INVALID_ARGUMENT"});
    }
  } finally { vi.unstubAllEnvs(); }
});
