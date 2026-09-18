import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sourceFixture } from "../fixtures/source-fixture.js";
import { auditSource } from "../../src/source/audit.js";
import * as sourceModule from "../../src/source/audit.js";
import { runCli } from "../../src/cli.js";
import { isolatedPostgresConfig } from "./config.js";
import { importAuditedSource } from "../../src/import/runner.js";
import { createPostgresImportBackend } from "../../src/postgres/import-backend.js";
import type { ImportBackend, ImportSession } from "../../src/import/types.js";
import { createPgHarness } from "./harness.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const h = await createPgHarness(); cleanups.push(() => h.close());
  const fixture = await sourceFixture();
  const out = await mkdtemp(join(tmpdir(), "area-import-audit-"));
  cleanups.push(() => rm(fixture.directory, { recursive: true, force: true }), () => rm(out, { recursive: true, force: true }));
  const audit = await auditSource(fixture.directory, out, fixture.manifest);
  const backend = createPostgresImportBackend(h.pool, { schemaName: h.schemaName });
  return { h, fixture, audit, backend, table: `"${h.schemaName}"` };
}
function wrap(backend: ImportBackend, decorate: (session: ImportSession) => ImportSession): ImportBackend {
  return { withDatasetLock: (version, work) => backend.withDatasetLock(version, session => work(decorate(session))) };
}

it("reuses the version and row IDs after a repeated import and preserves presentation", async () => {
  const { h, audit, backend, table } = await setup();
  const first = await importAuditedSource(backend, audit, { batchSize: 2 });
  expect(first.status).toBe("ready"); expect(first.levelCounts).toEqual({1:1,2:1,3:2,4:1,5:1});
  await h.pool.query(`UPDATE ${table}.area_region SET display_name='本地',sort=7,enabled=false,revision=3 WHERE code='01'`);
  const rows = await h.pool.query(`SELECT * FROM ${table}.area_region ORDER BY code`);
  const beforeDataset = await h.pool.query(`SELECT * FROM ${table}.area_dataset`);
  const second = await importAuditedSource(backend, audit, { batchSize: 2 });
  expect(second.datasetId).toBe(first.datasetId); expect(second.isActive).toBe(false);
  expect((await h.pool.query(`SELECT * FROM ${table}.area_region ORDER BY code`)).rows).toEqual(rows.rows);
  expect((await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows).toEqual(beforeDataset.rows);
});

it.each([0, -1, 1.5, 5001, NaN])("rejects invalid batch size %s without creating a dataset", async batchSize => {
  const { h, audit, backend, table } = await setup();
  await expect(importAuditedSource(backend, audit, {batchSize})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  expect((await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rowCount).toBe(0);
});

it.each(["raw", "normalized", "ancestor", "report", "manifest"])("rejects modified %s inputs before creating a dataset", async kind => {
  const { h, fixture, audit, backend, table } = await setup();
  if (kind === "raw") await appendFile(join(fixture.directory, fixture.manifest.files[0]!.path), "02,注入省\n");
  if (kind === "normalized") await writeFile(audit.normalizedFiles[1], (await readFile(audit.normalizedFiles[1], "utf8")).replace("合成省", "篡改省"));
  if (kind === "ancestor") await writeFile(audit.normalizedFiles[3], (await readFile(audit.normalizedFiles[3], "utf8")).replaceAll('"01","0101"', '"02","0101"'));
  if (kind === "report") audit.report.passed = false;
  if (kind === "manifest") audit.manifest.files[0]!.sha256 = "0".repeat(64);
  await expect(importAuditedSource(backend, audit)).rejects.toThrow();
  expect((await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rowCount).toBe(0);
});

it("fails immediately on competing first import and creates nothing before the lock", async () => {
  const { h, audit, backend, table } = await setup();
  await backend.withDatasetLock(audit.manifest.versionCode, async () => {
    await expect(importAuditedSource(backend, audit)).rejects.toMatchObject({code:"IMPORT_CONFLICT"});
    expect((await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rowCount).toBe(0);
  });
  await expect(importAuditedSource(backend, audit)).resolves.toMatchObject({status:"ready"});
});

it("resumes failed imports, verifies replayed rows, and keeps committed IDs", async () => {
  const { h, audit, backend, table } = await setup(); let batches = 0;
  const failing = wrap(backend, session => ({...session, async appendBatch(...args) {
    if (++batches === 3) throw new Error("injected interruption");
    return session.appendBatch(...args);
  }}));
  await expect(importAuditedSource(failing, audit, {batchSize:1})).rejects.toThrow("injected interruption");
  const committed = (await h.pool.query(`SELECT id,code FROM ${table}.area_region ORDER BY code`)).rows;
  expect(committed).toHaveLength(2);
  const failed = (await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows[0];
  expect(failed.status).toBe("failed"); expect(failed.import_report.passed).toBe(false);
  expect(failed.import_report.samples.length).toBeGreaterThan(0);
  expect(failed.import_progress).toEqual({level:2,recordsCommitted:1,batchSize:1});
  const ready = await importAuditedSource(backend, audit, {batchSize:2});
  expect(ready.datasetId).toBe(failed.id);
  expect((await h.pool.query(`SELECT id,code FROM ${table}.area_region WHERE level<=2 ORDER BY code`)).rows).toEqual(committed);
});

it("rolls back rows together with batch progress on a database failure", async () => {
  const { h, audit, backend, table } = await setup();
  await h.pool.query(`ALTER TABLE ${table}.area_dataset ADD CONSTRAINT injected_failure CHECK (NOT (import_progress @> '{"level":3}'))`);
  await expect(importAuditedSource(backend, audit, {batchSize:2})).rejects.toThrow();
  expect((await h.pool.query(`SELECT code FROM ${table}.area_region ORDER BY code`)).rows).toEqual([{code:"01"},{code:"0101"}]);
  expect((await h.pool.query(`SELECT import_progress FROM ${table}.area_dataset`)).rows[0].import_progress).toEqual({level:2,recordsCommitted:1,batchSize:2});
  await h.pool.query(`ALTER TABLE ${table}.area_dataset DROP CONSTRAINT injected_failure`);
  await expect(importAuditedSource(backend, audit)).resolves.toMatchObject({status:"ready"});
});

it("replays an ambiguously committed batch without duplicate IDs", async () => {
  const { h, audit, backend, table } = await setup(); let once = true;
  const lostResponse = wrap(backend, session => ({...session, async appendBatch(...args) {
    await session.appendBatch(...args);
    if (once) { once = false; throw new Error("COMMIT response lost"); }
  }}));
  await expect(importAuditedSource(lostResponse, audit)).rejects.toThrow("COMMIT response lost");
  const original = (await h.pool.query(`SELECT id FROM ${table}.area_region WHERE code='01'`)).rows[0].id;
  await importAuditedSource(backend, audit);
  expect((await h.pool.query(`SELECT id FROM ${table}.area_region WHERE code='01'`)).rows[0].id).toBe(original);
  expect((await h.pool.query(`SELECT * FROM ${table}.area_region`)).rowCount).toBe(6);
});

it("rejects same-count content corruption before ready and records database digests", async () => {
  const { h, audit, backend, table } = await setup();
  const corrupt = wrap(backend, session => ({...session, async auditDataset(id) {
    await h.pool.query(`UPDATE ${table}.area_region SET source_name='损坏' WHERE code='010101001001'`);
    return session.auditDataset(id);
  }}));
  await expect(importAuditedSource(corrupt, audit)).rejects.toThrow();
  const row = (await h.pool.query(`SELECT status,import_report FROM ${table}.area_dataset`)).rows[0];
  expect(row.status).toBe("failed"); expect(row.import_report.databaseDigests[5]).not.toBe(audit.report.sourceDigests[5]);
  await expect(importAuditedSource(backend, audit)).rejects.toThrow();
});

it("rejects a corrupted ready dataset without changing its state or report", async () => {
  const { h, audit, backend, table } = await setup();
  await importAuditedSource(backend, audit);
  const before = (await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows;
  await h.pool.query(`UPDATE ${table}.area_region SET source_name='损坏' WHERE code='01'`);
  await expect(importAuditedSource(backend, audit)).rejects.toThrow();
  expect((await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows).toEqual(before);
  const operationReport = JSON.parse(await readFile(join(audit.directory,"import-report.json"),"utf8"));
  expect(operationReport.passed).toBe(false);
  expect(operationReport.databaseDigests[1]).not.toBe(audit.report.sourceDigests[1]);
});

it("rejects manifest identity changes for an existing version", async () => {
  const { h, audit, backend, table } = await setup();
  await importAuditedSource(backend, audit);
  const before = (await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows;
  expect(before[0].import_report.passed).toBe(true);
  audit.manifest.rulesVersion = "different-rules";
  await expect(importAuditedSource(backend, audit)).rejects.toMatchObject({code:"IMPORT_CONFLICT"});
  expect((await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows).toEqual(before);
  const operationReport = JSON.parse(await readFile(join(audit.directory,"import-report.json"),"utf8"));
  expect(operationReport.passed).toBe(false);
  expect(operationReport.samples.length).toBeGreaterThan(0);
});

it.each(["raw source", "lock acquisition", "batch size"])("records a failed %s attempt before dataset resolution without altering accepted data", async phase => {
  const { h, fixture, audit, backend, table } = await setup();
  await importAuditedSource(backend, audit);
  const before = (await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows;
  expect(before[0].import_report.passed).toBe(true);
  if (phase === "raw source") {
    await appendFile(join(fixture.directory,fixture.manifest.files[0]!.path),"02,注入省\n");
    await expect(importAuditedSource(backend,audit)).rejects.toMatchObject({code:"IMPORT_CONFLICT"});
  } else if (phase === "lock acquisition") {
    await backend.withDatasetLock(audit.manifest.versionCode, async () => {
      await expect(importAuditedSource(backend,audit)).rejects.toMatchObject({code:"IMPORT_CONFLICT"});
    });
  } else {
    await expect(importAuditedSource(backend,audit,{batchSize:0})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  }
  expect((await h.pool.query(`SELECT * FROM ${table}.area_dataset`)).rows).toEqual(before);
  const operationReport = JSON.parse(await readFile(join(audit.directory,"import-report.json"),"utf8"));
  expect(operationReport.passed).toBe(false);
  expect(operationReport.samples.length).toBeGreaterThan(0);
  expect(operationReport.databaseDigests).toEqual({});
});

it("loses lock and writes together when its physical client is terminated, then resumes", async () => {
  const { h, audit, table } = await setup();
  let captured: PoolClient | undefined;
  const observingPool = { async connect() { captured = await h.pool.connect(); return captured; } } as Pool;
  const backend = createPostgresImportBackend(observingPool, {schemaName:h.schemaName});
  let once = true;
  const terminated = wrap(backend, session => ({...session, async appendBatch(...args) {
    if (once) {
      once = false;
      const pid = (await captured!.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await h.pool.query("SELECT pg_terminate_backend($1)", [pid]);
    }
    return session.appendBatch(...args);
  }}));
  await expect(importAuditedSource(terminated, audit)).rejects.toThrow();
  expect((await h.pool.query(`SELECT * FROM ${table}.area_region`)).rowCount).toBe(0);
  await expect(importAuditedSource(backend, audit)).resolves.toMatchObject({status:"ready"});
});

it("destroys a connection if lock acquisition succeeded but its response was lost", async () => {
  const { h, audit } = await setup();
  let pid = 0;
  const ambiguousPool = { async connect() {
    const client = await h.pool.connect();
    pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const query = client.query.bind(client);
    client.query = (async (...args: Parameters<PoolClient["query"]>) => {
      const result = await Reflect.apply(query, client, args);
      if (String(args[0]).includes("pg_try_advisory_lock")) throw new Error("lock response lost");
      return result;
    }) as PoolClient["query"];
    return client;
  }} as Pool;
  await expect(createPostgresImportBackend(ambiguousPool, {schemaName:h.schemaName})
    .withDatasetLock(audit.manifest.versionCode, async () => undefined)).rejects.toThrow("lock response lost");
  // A fresh session must not see that abandoned session still holding an advisory lock.
  expect((await h.pool.query("SELECT * FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [pid])).rows).toEqual([]);
});

it("destroys the connection if unlocking fails, and rejects captured session methods", async () => {
  const { h, audit } = await setup(); let pid = 0;
  let escaped: ImportSession["ensureDataset"] | undefined;
  const failingUnlock = { async connect() {
    const client = await h.pool.connect();
    pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const query = client.query.bind(client);
    client.query = (async (...args: Parameters<PoolClient["query"]>) => {
      if (String(args[0]).includes("pg_advisory_unlock")) throw new Error("unlock unavailable");
      return Reflect.apply(query, client, args);
    }) as PoolClient["query"];
    return client;
  }} as Pool;
  await createPostgresImportBackend(failingUnlock, {schemaName:h.schemaName})
    .withDatasetLock(audit.manifest.versionCode, async session => { escaped = session.ensureDataset; });
  await expect(escaped!(audit.manifest)).rejects.toMatchObject({code:"IMPORT_CONFLICT"});
  expect((await h.pool.query("SELECT * FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [pid])).rows).toEqual([]);
});


it("imports a maximum-size batch offline and audits more than one keyset page", async () => {
  const { h, fixture, audit, backend, table } = await setup();
  const villages = "code,name,streetCode,areaCode,cityCode,provinceCode\n" + Array.from({length:5000}, (_,index) =>
    `010101${String(index).padStart(6,"0")},合成村${index},010101001,010101,0101,01\n`).join("");
  const file = fixture.manifest.files[4]!;
  file.bytes = Buffer.byteLength(villages); file.sha256 = createHash("sha256").update(villages).digest("hex");
  await writeFile(join(fixture.directory,file.path),villages);
  const refreshed = await auditSource(fixture.directory,audit.directory,fixture.manifest);
  vi.stubGlobal("fetch", () => { throw new Error("Network disabled"); });
  try {
    const dataset = await importAuditedSource(backend,refreshed,{batchSize:5000});
    expect(dataset.status).toBe("ready"); expect(dataset.levelCounts[5]).toBe(5000);
    expect((await h.pool.query(`SELECT count(*)::int AS count FROM ${table}.area_region`)).rows[0].count).toBe(5005);
  } finally { vi.unstubAllGlobals(); }
});


it.each(["separate", "inline"] as const)("CLI imports into a custom schema with %s activation using only the ephemeral connection", async activation => {
  const { h, fixture, audit, table } = await setup();
  const originalAudit = auditSource;
  // Only the source manifest is synthetic; schema routing uses the real CLI and backend.
  vi.spyOn(sourceModule,"auditSource").mockImplementation((directory,output) => originalAudit(directory,output,fixture.manifest));
  const config = isolatedPostgresConfig();
  const connection = new URL("postgres://isolated-test-only:isolated-test-only@localhost/area_kit_ephemeral_test");
  connection.hostname = config.host; connection.port = String(config.port);
  vi.stubEnv("AREA_KIT_DATABASE_URL",connection.toString());
  const outputs: string[] = [];
  vi.spyOn(process.stdout,"write").mockImplementation(chunk => { outputs.push(String(chunk)); return true; });
  try {
    await runCli(["import","--schema",h.schemaName,"--dir",fixture.directory,"--report-dir",audit.directory,"--batch-size","2", ...(activation === "inline" ? ["--activate"] : [])]);
    const imported = JSON.parse(outputs.join(""));
    expect(imported.status).toBe("ready");
    expect(imported.isActive).toBe(activation === "inline");
    expect(outputs.join("")).not.toContain(connection.toString());
    expect((await h.pool.query(`SELECT status,is_active FROM ${table}.area_dataset`)).rows).toEqual([{status:"ready",is_active:activation === "inline"}]);
    expect((await h.pool.query(`SELECT * FROM ${table}.area_region`)).rowCount).toBe(6);
    if (activation === "separate") {
      outputs.length = 0;
      await runCli(["activate", "--dataset-id", imported.datasetId, "--schema", h.schemaName]);
      expect(JSON.parse(outputs.join(""))).toMatchObject({datasetId: imported.datasetId, isActive: true});
      expect((await h.pool.query(`SELECT is_active FROM ${table}.area_dataset`)).rows).toEqual([{is_active:true}]);
    }
  } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
