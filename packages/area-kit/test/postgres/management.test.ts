import { afterEach, expect, it } from "vitest";
import { createDrizzleAreaStore } from "../../src/postgres/store.js";
import { createAreaKit } from "../../src/server/index.js";
import { createPgHarness } from "./harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(status: "importing" | "ready" | "failed" = "ready") {
  const h = await createPgHarness();
  cleanups.push(() => h.close());
  const datasetId = await h.seedDataset({ status, isActive: status === "ready", versionCode: "v1" });
  const parent = await h.seedRegion(datasetId, { level: 1, code: "01", sourceName: "合成省", parentCode: null,
    nodeKind: "unknown", ancestorCodes: [] });
  await h.seedRegion(datasetId, { level: 2, code: "0101", sourceName: "合成市", parentCode: "01",
    nodeKind: "unknown", ancestorCodes: ["01"] }, parent);
  return { h, datasetId, store: createDrizzleAreaStore(h.pool, { schemaName: h.schemaName }) };
}

it("disables descendants when only the parent presentation is disabled", async () => {
  const { datasetId, store } = await setup();
  const kit = createAreaKit({ store, authorize: async () => true });

  await kit.updatePresentation(null, { datasetId, code: "01", revision: 1, patch: { enabled: false } });

  expect((await kit.getRegion(null, { datasetId, code: "0101" })).selectable).toBe(false);
});

it("updates only accepted presentation fields and reports real concurrent revisions", async () => {
  const { datasetId, store } = await setup();
  const kit = createAreaKit({ store, authorize: async () => true });

  await expect(kit.updatePresentation(null, { datasetId, code: "01", revision: 1,
    patch: { displayName: "  本地省  ", sort: -8 } })).resolves.toMatchObject({
    code: "01", label: "本地省", sort: -8, revision: 2,
  });
  expect(await kit.getRegion(null, { datasetId, code: "01" })).toMatchObject({ label: "本地省", sort: -8, revision: 2 });
  await expect(kit.updatePresentation(null, { datasetId, code: "01", revision: 1, patch: { enabled: false } }))
    .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(kit.updatePresentation(null, { datasetId, code: "01", revision: 2, patch: {} }))
    .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(kit.updatePresentation(null, { datasetId, code: "01", revision: 2,
    patch: { sourceName: "forged" } as never })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(kit.updatePresentation(null, { datasetId, code: "01", revision: 2,
    patch: { sort: 2 ** 31 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await kit.updatePresentation(null, { datasetId, code: "01", revision: 2, patch: { displayName: "   " } });
  expect((await kit.getRegion(null, { datasetId, code: "01" })).label).toBe("合成省");
  await expect(kit.updatePresentation(null, { datasetId, code: "missing", revision: 1, patch: { enabled: false } }))
    .rejects.toMatchObject({ code: "UNKNOWN_CODE" });
});

it("authorizes management separately and never opens a write transaction after denial", async () => {
  const { datasetId, store } = await setup();
  let writes = 0;
  const kit = createAreaKit({ store: { ...store, write: async work => {
    writes += 1;
    return store.write(work);
  } }, authorize: async (_ctx, request) => request.action === "read" });

  await expect(kit.updatePresentation(null, { datasetId, code: "01", revision: 1, patch: { enabled: false } }))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(writes).toBe(0);
  expect((await createAreaKit({ store, authorize: async () => true }).getRegion(null, { datasetId, code: "01" })).enabled).toBe(true);
});

it("uses admin read without public read and returns only the finite management report", async () => {
  const { h, datasetId, store } = await setup("failed");
  await h.pool.query(`UPDATE "${h.schemaName}".area_dataset
    SET import_progress=$2::jsonb, import_report=$3::jsonb WHERE id=$1`, [datasetId,
    JSON.stringify({ level: 2, recordsCommitted: 9, batchSize: 3, secret: "progress-secret" }),
    JSON.stringify({ passed: false, counts: { 1: { input: 1, valid: 1, duplicate: 0, conflict: 0, missingParent: 0,
      ancestorMismatch: 0, invalid: 0 } }, issuesPath: null, samples: [], digestAlgorithm: "sha256", sourceDigests: {},
      databaseDigests: {}, inheritanceConflicts: 0, secret: "report-secret" })]);
  const actions: string[] = [];
  const kit = createAreaKit({ store, authorize: async (_ctx, request) => {
    actions.push(request.action);
    return request.action === "admin.read";
  } });

  const report = await kit.getDatasetReport(null, { datasetId });

  expect(actions).toEqual(["admin.read", "admin.read"]);
  expect(report).toMatchObject({ datasetId, versionCode: "v1", progress: { level: 2, recordsCommitted: 9, batchSize: 3 },
    report: { passed: false, digestAlgorithm: "sha256" } });
  expect(JSON.stringify(report)).not.toContain("secret");
  await expect(kit.getRegion(null, { datasetId, code: "01" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(kit.updatePresentation(null, { datasetId, code: "01", revision: 1, patch: { enabled: false } }))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("keeps historical ready datasets readable while rejecting writes to failed targets", async () => {
  const { h, datasetId, store } = await setup();
  const kit = createAreaKit({ store, authorize: async () => true });
  await kit.updatePresentation(null, { datasetId, code: "01", revision: 1, patch: { enabled: false } });
  await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET is_active=false WHERE id=$1`, [datasetId]);
  await h.seedDataset({ status: "ready", isActive: true, versionCode: "current" });
  const failedId = await h.seedDataset({ status: "failed", versionCode: "failed" });
  const failedRoot = await h.seedRegion(failedId, { level: 1, code: "99", sourceName: "失败省", parentCode: null,
    nodeKind: "unknown", ancestorCodes: [] });
  expect(await kit.getRegion(null, { datasetId, code: "01" })).toMatchObject({ code: "01", enabled: false });
  await expect(kit.updatePresentation(null, { datasetId: failedId, code: "99", revision: 1, patch: { enabled: false } }))
    .rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
  expect((await store.read(view => view.findNodes(failedId, ["99"])))[0]).toMatchObject({ code: "99", enabled: true });
  expect(failedRoot).toBeTruthy();
});
