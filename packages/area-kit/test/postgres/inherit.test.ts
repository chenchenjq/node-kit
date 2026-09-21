import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { sameSourceMeaning } from "../../src/import/inherit.js";
import { importAuditedSource } from "../../src/import/runner.js";
import type { ImportBackend, ImportSession } from "../../src/import/types.js";
import { createPostgresImportBackend } from "../../src/postgres/import-backend.js";
import { createDrizzleAreaStore } from "../../src/postgres/store.js";
import type { StoredRegion } from "../../src/server/ports.js";
import { auditSource } from "../../src/source/audit.js";
import { sourceFixture } from "../fixtures/source-fixture.js";
import { createPgHarness } from "./harness.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root: StoredRegion = {code:"01",sourceName:"省",displayName:null,level:1,parentCode:null,nodeKind:"unknown",enabled:true,sort:0,revision:1};
const city: StoredRegion = {...root,code:"0101",sourceName:"市",level:2,parentCode:"01"};
it("compares complete source paths and ignores local settings", () => {
  expect(sameSourceMeaning([root,city],[{...root,sourceName:"新省"},city])).toBe(false);
  expect(sameSourceMeaning([root,city],[root,city].map(row => ({...row,displayName:"local",sort:8,enabled:false,revision:9})))).toBe(true);
  expect(sameSourceMeaning([root,city],[city])).toBe(false);
  for (const change of [{code:"02"},{level:2 as const},{parentCode:"00"},{nodeKind:"group" as const}]) {
    expect(sameSourceMeaning([root,city],[{...root,...change},city])).toBe(false);
  }
});
async function setup(large = false) {
  const h = await createPgHarness(); cleanups.push(() => h.close());
  const fixture = await sourceFixture(), out = await mkdtemp(join(tmpdir(),"area-inherit-"));
  cleanups.push(() => rm(fixture.directory,{recursive:true,force:true}), () => rm(out,{recursive:true,force:true}));
  const backend = createPostgresImportBackend(h.pool,{schemaName:h.schemaName});
  if (large) {
    const file = fixture.manifest.files[4]!;
    const path = join(fixture.directory,file.path);
    const content = await readFile(path,"utf8") + Array.from({length:1100},(_,i) =>
      `010101${String(2000+i).padStart(6,"0")},合成村,010101001,010101,0101,01\n`).join("");
    await writeFile(path,content);
    file.bytes = Buffer.byteLength(content); file.sha256 = createHash("sha256").update(content).digest("hex");
  }
  const oldAudit = await auditSource(fixture.directory,join(out,"old"),fixture.manifest);
  const source = await importAuditedSource(backend,oldAudit);
  const manifest = {...fixture.manifest,versionCode:"synthetic-test-only:v2"};
  const audit = await auditSource(fixture.directory,join(out,"new"),manifest);
  const table = `"${h.schemaName}"`;
  await h.pool.query(`UPDATE ${table}.area_region SET display_name='旧别名',sort=8,enabled=false WHERE dataset_id=$1 AND code='010101001001'`, [source.datasetId]);
  const store = createDrizzleAreaStore(h.pool,{schemaName:h.schemaName});
  const leaf = (id: string) => store.read(async view => (await view.findNodes(id,["010101001001"]))[0]!);
  return {h,backend,audit,source,table,store,leaf};
}
function wrap(backend: ImportBackend, decorate: (session: ImportSession) => ImportSession): ImportBackend {
  return {withDatasetLock:(version,work) => backend.withDatasetLock(version, session => work(decorate(session)))};
}
it("inherits only by explicit option and preserves source fields, digests and manual settings on ready retries", async () => {
  const {backend,audit,source,store,leaf} = await setup();
  const target = await importAuditedSource(backend,audit,{inheritFromDatasetId:source.datasetId});
  expect(target.isActive).toBe(false);
  expect(await leaf(target.datasetId)).toMatchObject({displayName:"旧别名",sort:8,enabled:false,sourceName:"合成村",revision:1});
  const record = await store.read(v => v.resolveDataset({datasetId:target.datasetId}));
  expect(record?.report.inheritanceConflicts).toBe(0);
  expect(record?.report.databaseDigests).toEqual(record?.report.sourceDigests);
  await store.write(v => v.updatePresentation(target.datasetId,"010101001001",1,{displayName:"manual"}));
  await importAuditedSource(backend,audit,{inheritFromDatasetId:source.datasetId});
  expect(await leaf(target.datasetId)).toMatchObject({displayName:"manual",revision:2});
  await backend.withDatasetLock(audit.manifest.versionCode,async session => {
    await session.ensureDataset(audit.manifest);
    await expect(session.inheritSettings(target.datasetId,source.datasetId)).rejects.toMatchObject({code:"IMPORT_CONFLICT"});
  });
});
it("does not inherit without an option", async () => {
  const {backend,audit,leaf} = await setup();
  const target = await importAuditedSource(backend,audit);
  expect(await leaf(target.datasetId)).toMatchObject({displayName:null,sort:0,enabled:true});
});
it.each(["node-name","ancestor-name","node-kind","ancestor-kind","node-parent","ancestor-parent"])("records a conflict for changed %s without copying settings", async change => {
  const {h,backend,audit,source,table,leaf,store} = await setup();
  const code = change.startsWith("node") ? "010101001001" : "0101";
  if (change.endsWith("name") || change.endsWith("kind")) {
    await h.pool.query(`UPDATE ${table}.area_region SET ${change.endsWith("name") ? "source_name='changed'" : "node_kind='group'"} WHERE dataset_id=$1 AND code=$2`, [source.datasetId,code]);
  } else {
    const level = change.startsWith("node") ? 4 : 1;
    const parent = level === 4 ? (await h.pool.query(`SELECT id FROM ${table}.area_region WHERE dataset_id=$1 AND code='010101'`, [source.datasetId])).rows[0].id : null;
    const alternate = await h.seedRegion(source.datasetId,{code:"alternate",sourceName:"替代祖先",level,parentCode:null,nodeKind:"unknown",ancestorCodes:[]},parent);
    await h.pool.query(`UPDATE ${table}.area_region SET parent_id=$1 WHERE dataset_id=$2 AND code=$3`,[alternate,source.datasetId,code]);
  }
  const target = await importAuditedSource(backend,audit,{inheritFromDatasetId:source.datasetId});
  expect(await leaf(target.datasetId)).toMatchObject({displayName:null,sort:0,enabled:true});
  expect((await store.read(v => v.resolveDataset({datasetId:target.datasetId})))?.report.inheritanceConflicts).toBe(1);
});
it("rolls back inherited rows and completion progress together, then resumes from the start", async () => {
  const {h,backend,audit,source,table,leaf} = await setup();
  await h.pool.query(`ALTER TABLE ${table}.area_dataset ADD CONSTRAINT fail_inheritance CHECK (NOT (import_progress ? 'inheritance'))`);
  await expect(importAuditedSource(backend,audit,{inheritFromDatasetId:source.datasetId})).rejects.toThrow();
  const target = (await h.pool.query(`SELECT id,import_progress FROM ${table}.area_dataset WHERE version_code=$1`,[audit.manifest.versionCode])).rows[0];
  expect(target.import_progress).not.toHaveProperty("inheritance");
  expect(await leaf(target.id)).toMatchObject({displayName:null,sort:0,enabled:true});
  await h.pool.query(`ALTER TABLE ${table}.area_dataset DROP CONSTRAINT fail_inheritance`);
  await importAuditedSource(backend,audit,{inheritFromDatasetId:source.datasetId});
  expect(await leaf(target.id)).toMatchObject({displayName:"旧别名",sort:8,enabled:false});
});

it("keeps one source snapshot across pages and exposes no partially inherited settings", async () => {
  const {h,audit,source,table,store} = await setup(true);
  await h.pool.query(`UPDATE ${table}.area_region SET display_name='before' WHERE dataset_id=$1 AND level=5`,[source.datasetId]);
  let interleaved = false;
  const observingPool = {async connect() {
    const client = await h.pool.connect(); const query = client.query.bind(client);
    client.query = (async (...args: Parameters<PoolClient["query"]>) => {
      const result = await Reflect.apply(query,client,args);
      if (!interleaved && /^UPDATE .*area_region/.test(String(args[0]))) {
        interleaved = true;
        const partial = await h.pool.query(`SELECT display_name FROM ${table}.area_region WHERE dataset_id<>$1 AND display_name IS NOT NULL`,[source.datasetId]);
        expect(partial.rows).toEqual([]);
        await store.write(async () => {
          await h.pool.query(`UPDATE ${table}.area_region SET display_name='after' WHERE dataset_id=$1 AND level=5`,[source.datasetId]);
        });
      }
      return result;
    }) as PoolClient["query"];
    const release = client.release.bind(client);
    client.release = (...args) => { client.query = query; release(...args); };
    return client;
  }} as Pool;
  const observed = createPostgresImportBackend(observingPool,{schemaName:h.schemaName});
  const target = await importAuditedSource(observed,audit,{inheritFromDatasetId:source.datasetId});
  expect(interleaved).toBe(true);
  expect((await h.pool.query(`SELECT display_name,count(*)::int AS count FROM ${table}.area_region WHERE dataset_id=$1 AND level=5 GROUP BY display_name`,[target.datasetId])).rows)
    .toEqual([{display_name:"before",count:1101}]);
  expect((await h.pool.query(`SELECT DISTINCT display_name FROM ${table}.area_region WHERE dataset_id=$1 AND level=5`,[source.datasetId])).rows)
    .toEqual([{display_name:"after"}]);
});
it("rejects missing, failed and self inheritance sources", async () => {
  const {h,backend,audit} = await setup();
  for (const id of ["00000000-0000-0000-0000-000000000000",await h.seedDataset({status:"failed"})]) {
    await expect(importAuditedSource(backend,audit,{inheritFromDatasetId:id})).rejects.toThrow();
  }
  await backend.withDatasetLock(audit.manifest.versionCode,async session => {
    const target = await session.ensureDataset(audit.manifest);
    await expect(session.inheritSettings(target.datasetId,target.datasetId)).rejects.toThrow();
  });
});
it("reuses committed inheritance after a later interruption and rejects changing its source", async () => {
  const {h,backend,audit,source,table,leaf,store} = await setup();
  const interrupted = wrap(backend,session => ({...session,async auditDataset() {throw new Error("after inheritance");}}));
  await expect(importAuditedSource(interrupted,audit,{inheritFromDatasetId:source.datasetId})).rejects.toThrow("after inheritance");
  const record = (await h.pool.query(`SELECT id,import_progress FROM ${table}.area_dataset WHERE version_code=$1`,[audit.manifest.versionCode])).rows[0];
  expect(record.import_progress.inheritance).toEqual({sourceId:source.datasetId,completed:true,conflicts:0});
  await store.write(v => v.updatePresentation(source.datasetId,"010101001001",1,{displayName:"later source edit"}));
  const other = await h.seedDataset({status:"ready"});
  await expect(importAuditedSource(backend,audit,{inheritFromDatasetId:other})).rejects.toMatchObject({code:"IMPORT_CONFLICT"});
  const target = await importAuditedSource(backend,audit,{inheritFromDatasetId:source.datasetId});
  expect(target.datasetId).toBe(record.id);
  expect(await leaf(target.datasetId)).toMatchObject({displayName:"旧别名",revision:1});
});
it("counts a customized node absent from the target as a conflict and keeps source rows unchanged", async () => {
  const {h,backend,audit,source,table,store} = await setup();
  await h.seedRegion(source.datasetId,{code:"removed",sourceName:"已移除",level:1,parentCode:null,nodeKind:"unknown",ancestorCodes:[]});
  await h.pool.query(`UPDATE ${table}.area_region SET display_name='removed alias' WHERE code='removed'`);
  const before = (await h.pool.query(`SELECT * FROM ${table}.area_region WHERE dataset_id=$1 ORDER BY code`,[source.datasetId])).rows;
  const target = await importAuditedSource(backend,audit,{inheritFromDatasetId:source.datasetId});
  expect((await store.read(v => v.resolveDataset({datasetId:target.datasetId})))?.report.inheritanceConflicts).toBe(1);
  expect(await store.read(v => v.findNodes(target.datasetId,["removed"]))).toEqual([]);
  expect((await h.pool.query(`SELECT * FROM ${table}.area_region WHERE dataset_id=$1 ORDER BY code`,[source.datasetId])).rows).toEqual(before);
});
it("retains committed conflict reporting when retry omits inheritance after a lost completion response", async () => {
  const {h,backend,audit,source,table,store} = await setup();
  await h.pool.query(`UPDATE ${table}.area_region SET source_name='旧语义' WHERE dataset_id=$1 AND code='01'`,[source.datasetId]);
  const lostResponse = wrap(backend,session => ({...session,async inheritSettings(...args) {
    await session.inheritSettings(...args); throw new Error("completion response lost");
  }}));
  await expect(importAuditedSource(lostResponse,audit,{inheritFromDatasetId:source.datasetId})).rejects.toThrow("completion response lost");
  const target = await importAuditedSource(backend,audit);
  expect((await store.read(v => v.resolveDataset({datasetId:target.datasetId})))?.report.inheritanceConflicts).toBe(1);
});
