import { afterEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createAreaHost } from "../../examples/next/lib/host.js";
import { createPgHarness, type PgHarness } from "./harness.js";
import { activateDataset, createDrizzleAreaStore } from "area-kit/postgres";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const request = () => new Request("https://example.test/api/address-selection", {method: "POST", headers: {origin: "https://example.test"}});
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return {promise, open}; }
async function setup() {
  const h = await createPgHarness(); cleanups.push(() => h.close());
  const datasetId = await h.seedDataset({status: "ready", isActive: true});
  const parent = await h.seedRegion(datasetId, {level: 1, code: "01", sourceName: "合成省", parentCode: null, nodeKind: "unknown", ancestorCodes: []});
  await h.seedRegion(datasetId, {level: 2, code: "0101", sourceName: "合成市", parentCode: "01", nodeKind: "unknown", ancestorCodes: ["01"]}, parent);
  return {h, datasetId, input: {datasetId, pathCodes: ["01", "0101"]}};
}
function deps(h: PgHarness) {
  return {pool: h.pool, schemaName: h.schemaName, authorize: async () => true,
    authenticate: async () => ({session: "trusted"}), protectRequest: async () => {}, previewPolicy: () => ({}),
    submissionPolicy: () => ({targetLevel: 2 as const, policy: {}, versionPolicy: "active-only" as const}),
    persist: vi.fn(async (_client: PoolClient) => {}), origin: "https://example.test"};
}

it("uses the host target level instead of a lower request target", async () => {
  const {h, input} = await setup(); const options = deps(h);
  const host = createAreaHost({...options, submissionPolicy: () => ({targetLevel: 3, policy: {}, versionPolicy: "active-only"})});
  await expect(host.submit(request(), {...input, targetLevel: 1})).rejects.toMatchObject({code: "TARGET_LEVEL_NOT_REACHED", reason: "TARGET_LEVEL_NOT_REACHED"});
  expect(options.persist).not.toHaveBeenCalled();
});

it.each(["disable", "activate"] as const)("holds the shared library lock through persist while %s waits", async action => {
  const {h, datasetId, input} = await setup();
  const next = await h.seedDataset({status: "ready"});
  await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET import_report='{"passed":true}' WHERE id=$1`, [next]);
  const entered = gate(), finish = gate();
  const host = createAreaHost({...deps(h), persist: async () => { entered.open(); await finish.promise; }});
  const submission = host.submit(request(), input);
  await entered.promise;
  const writer = action === "disable"
    ? host.kit.updatePresentation({session: "trusted"}, {datasetId, code: "01", revision: 1, patch: {enabled: false}})
    : activateDataset(createDrizzleAreaStore(h.pool, {schemaName: h.schemaName}), next);
  try {
    await vi.waitFor(async () => {
      const result = await h.pool.query(`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
      expect(result.rows[0].count).toBeGreaterThan(0);
    });
  } finally { finish.open(); }
  await expect(submission).resolves.toMatchObject({accepted: true, datasetId});
  await writer;
  await expect(host.submit(request(), input)).rejects.toMatchObject({code: action === "disable" ? "NOT_SELECTABLE" : "VERSION_UNAVAILABLE"});
});

it("persists using the same READ COMMITTED transaction and rolls back a failed business write", async () => {
  const {h, input} = await setup();
  await h.pool.query(`CREATE TABLE "${h.schemaName}".host_address (code text, path_names jsonb)`);
  let reject = false;
  const host = createAreaHost({...deps(h), persist: async (client, selection) => {
    expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
    const lock = await client.query("SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted");
    expect(lock.rows).toEqual([{mode: "ShareLock"}]);
    await client.query(`INSERT INTO "${h.schemaName}".host_address VALUES ($1,$2)`, [selection.code, JSON.stringify(selection.pathNames)]);
    expect((await client.query(`SELECT count(*)::int AS count FROM "${h.schemaName}".host_address`)).rows[0].count).toBe(reject ? 2 : 1);
    expect((await h.pool.query(`SELECT count(*)::int AS count FROM "${h.schemaName}".host_address`)).rows[0].count).toBe(reject ? 1 : 0);
    if (reject) throw new Error("business failure");
  }});
  await host.submit(request(), input);
  reject = true;
  await expect(host.submit(request(), input)).rejects.toThrow("business failure");
  expect((await h.pool.query(`SELECT * FROM "${h.schemaName}".host_address`)).rows).toEqual([{code: "0101", path_names: ["合成省", "合成市"]}]);
});

it("reads only after acquiring the shared lock and sees the writer's committed change", async () => {
  const {h, datasetId, input} = await setup();
  const writer = await h.pool.connect();
  await writer.query("BEGIN");
  await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`area-kit:library:${h.schemaName}`]);
  await writer.query(`UPDATE "${h.schemaName}".area_region SET enabled=false WHERE dataset_id=$1 AND code='01'`, [datasetId]);
  const options = deps(h), host = createAreaHost(options);
  const submission = host.submit(request(), input);
  const rejected = expect(submission).rejects.toMatchObject({code: "NOT_SELECTABLE"});
  try {
    await vi.waitFor(async () => {
      const locks = await h.pool.query("SELECT mode FROM pg_locks WHERE locktype='advisory' AND NOT granted");
      expect(locks.rows).toContainEqual({mode: "ShareLock"});
    });
  } finally { await writer.query("COMMIT"); writer.release(); }
  await rejected;
  expect(options.persist).not.toHaveBeenCalled();
});

it("requires explicit versions and authenticates, protects, and authorizes with trusted context", async () => {
  const {h, input} = await setup(); const options = deps(h);
  const ctx = {session: "server-session"};
  const authenticate = vi.fn(async () => ctx), protectRequest = vi.fn(async () => {});
  const authorize = vi.fn(async () => false), submissionPolicy = vi.fn(options.submissionPolicy);
  const host = createAreaHost({...options, authenticate, protectRequest, authorize, submissionPolicy});
  await expect(host.submit(new Request("https://example.test", {method: "POST"}), input)).rejects.toMatchObject({code: "FORBIDDEN"});
  expect(authenticate).not.toHaveBeenCalled();
  const req = request();
  await expect(host.submit(req, input)).rejects.toMatchObject({code: "FORBIDDEN"});
  expect(protectRequest).toHaveBeenCalledWith(req, ctx);
  expect(submissionPolicy).toHaveBeenCalledWith(ctx);
  expect(authorize).toHaveBeenCalledWith(ctx, expect.objectContaining({action: "read"}));
  expect(options.persist).not.toHaveBeenCalled();
  await expect(createAreaHost(options).submit(request(), {pathCodes: input.pathCodes})).rejects.toMatchObject({code: "INVALID_ARGUMENT"});
  await expect(createAreaHost({...options, protectRequest: async () => { throw new Error("CSRF rejected"); }}).submit(request(), input)).rejects.toThrow("CSRF rejected");
  for (const extra of [{policy: {allowEarlyTermination: true}}, {role: "admin"}, {ctx: {session: "admin"}}]) {
    await expect(createAreaHost(options).submit(request(), {...input, ...extra})).rejects.toMatchObject({code: "INVALID_ARGUMENT"});
  }
});

it("rejects historical versions by default and permits explicitly trusted specified-ready policy without modifying history", async () => {
  const {h, datasetId, input} = await setup();
  await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET is_active=false WHERE id=$1`, [datasetId]);
  await h.seedDataset({status: "ready", isActive: true});
  const options = deps(h), host = createAreaHost(options);
  await expect(host.submit(request(), input)).rejects.toMatchObject({code: "VERSION_UNAVAILABLE", reason: "DATASET_NOT_ACCEPTED"});
  const before = (await h.pool.query(`SELECT * FROM "${h.schemaName}".area_region ORDER BY code`)).rows;
  const historical = createAreaHost({...options, submissionPolicy: () => ({targetLevel: 2, policy: {}, versionPolicy: "specified-ready"})});
  await expect(historical.submit(request(), input)).resolves.toMatchObject({datasetId, accepted: true});
  await historical.kit.getPath({session: "trusted"}, {datasetId, code: "0101"});
  expect((await h.pool.query(`SELECT * FROM "${h.schemaName}".area_region ORDER BY code`)).rows).toEqual(before);
});
