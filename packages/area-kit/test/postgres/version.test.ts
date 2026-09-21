import { afterEach, expect, it } from "vitest";
import { activateDataset } from "../../src/import/activate.js";
import { createDrizzleAreaStore } from "../../src/postgres/store.js";
import type { AreaStore } from "../../src/server/ports.js";
import { createPgHarness } from "./harness.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const h = await createPgHarness(); cleanups.push(() => h.close());
  const store = createDrizzleAreaStore(h.pool, {schemaName:h.schemaName});
  async function ready(versionCode: string) {
    const id = await h.seedDataset({status:"ready",versionCode});
    await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET import_report='{"passed":true}' WHERE id=$1`, [id]);
    return id;
  }
  return {h,store,ready};
}
it("serializes concurrent activations and returns public summaries", async () => {
  const {h,store,ready} = await setup();
  const a = await ready("a"), b = await ready("b");
  const results = await Promise.all([activateDataset(store,a),activateDataset(store,b)]);
  for (const result of results) {
    expect(result.isActive).toBe(true); expect(result).not.toHaveProperty("report");
    expect(result).not.toHaveProperty("progress"); expect(result).not.toHaveProperty("fileChecksums");
  }
  expect((await h.pool.query(`SELECT id FROM "${h.schemaName}".area_dataset WHERE is_active`)).rows).toHaveLength(1);
  const active = await store.read(view => view.resolveDataset({}));
  await activateDataset(store,active!.datasetId);
  expect(await store.read(view => view.resolveDataset({}))).toEqual(active);
});
it("rejects unavailable or unaudited targets and preserves the previous active dataset", async () => {
  const {h,store,ready} = await setup();
  const a = await ready("a"); await activateDataset(store,a);
  for (const status of ["importing","failed","ready"] as const) {
    const target = await h.seedDataset({status});
    await expect(activateDataset(store,target)).rejects.toMatchObject({code:"VERSION_UNAVAILABLE"});
    expect((await store.read(view => view.resolveDataset({})))?.datasetId).toBe(a);
  }
  await expect(activateDataset(store,"00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({code:"VERSION_UNAVAILABLE"});
});
it("rolls back activation when the write callback fails after switching", async () => {
  const {store,ready} = await setup();
  const a = await ready("a"), b = await ready("b"); await activateDataset(store,a);
  const failing: AreaStore = {...store, write: work => store.write(async view => {
    await work(view); throw new Error("after switch");
  })};
  await expect(activateDataset(failing,b)).rejects.toThrow("after switch");
  expect((await store.read(view => view.resolveDataset({})))?.datasetId).toBe(a);
});
it.each(["importing","failed"] as const)("prevents presentation writes to %s datasets", async status => {
  const {h,store} = await setup(); const id = await h.seedDataset({status});
  await h.seedRegion(id,{code:"01",sourceName:"省",level:1,parentCode:null,nodeKind:"unknown",ancestorCodes:[]});
  await expect(store.write(view => view.updatePresentation(id,"01",1,{displayName:"manual"})))
    .rejects.toMatchObject({code:"VERSION_UNAVAILABLE"});
  expect((await store.read(view => view.findNodes(id,["01"])))[0]?.displayName).toBeNull();
});
it("CLI supports explicit activate, import --activate and --inherit-from with real isolated storage", async () => {
  const {mkdtemp,rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os"); const {join} = await import("node:path");
  const {vi} = await import("vitest");
  const sourceModule = await import("../../src/source/audit.js");
  const backendModule = await import("../../src/postgres/import-backend.js");
  const storeModule = await import("../../src/postgres/store.js");
  const {importAuditedSource} = await import("../../src/import/runner.js");
  const {sourceFixture} = await import("../fixtures/source-fixture.js");
  const {runCli} = await import("../../src/cli.js");
  const {isolatedPostgresConfig} = await import("./config.js");
  const {h,store} = await setup();
  const fixture = await sourceFixture(), output = await mkdtemp(join(tmpdir(),"area-cli-activate-"));
  cleanups.push(() => rm(fixture.directory,{recursive:true,force:true}), () => rm(output,{recursive:true,force:true}));
  const audit = await sourceModule.auditSource(fixture.directory,output,fixture.manifest);
  const backend = backendModule.createPostgresImportBackend(h.pool,{schemaName:h.schemaName});
  const first = await importAuditedSource(backend,audit);
  await store.write(v => v.updatePresentation(first.datasetId,"01",1,{displayName:"本地省"}));
  fixture.manifest.versionCode = "synthetic-test-only:v2";
  const originalAudit = sourceModule.auditSource, originalBackend = backendModule.createPostgresImportBackend;
  const originalStore = storeModule.createDrizzleAreaStore;
  vi.spyOn(sourceModule,"auditSource").mockImplementation((dir,out) => originalAudit(dir,out,fixture.manifest));
  vi.spyOn(backendModule,"createPostgresImportBackend").mockImplementation(pool => originalBackend(pool,{schemaName:h.schemaName}));
  vi.spyOn(storeModule,"createDrizzleAreaStore").mockImplementation(pool => originalStore(pool,{schemaName:h.schemaName}));
  const config = isolatedPostgresConfig();
  const connection = new URL("postgres://isolated-test-only:isolated-test-only@localhost/area_kit_ephemeral_test");
  connection.hostname = config.host; connection.port = String(config.port);
  vi.stubEnv("AREA_KIT_DATABASE_URL",connection.toString());
  const outputs: string[] = []; vi.spyOn(process.stdout,"write").mockImplementation(chunk => {outputs.push(String(chunk));return true;});
  try {
    await runCli(["import","--dir",fixture.directory,"--report-dir",output,"--activate","--inherit-from",first.datasetId]);
    const target = JSON.parse(outputs.join("")); expect(target.isActive).toBe(true);
    expect((await store.read(v => v.findNodes(target.datasetId,["01"])))[0]?.displayName).toBe("本地省");
    outputs.length = 0;
    await runCli(["activate","--dataset-id",first.datasetId]);
    expect(JSON.parse(outputs.join(""))).toMatchObject({datasetId:first.datasetId,isActive:true});
    expect((await store.read(v => v.resolveDataset({})))?.datasetId).toBe(first.datasetId);
  } finally {vi.restoreAllMocks();vi.unstubAllEnvs();}
});
