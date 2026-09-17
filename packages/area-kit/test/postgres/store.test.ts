import { expect, it } from "vitest";
import { createPgHarness, type PgHarness } from "./harness.js";
import { createDrizzleAreaStore, bindAreaStore } from "../../src/postgres/store.js";
import { lockAreaLibrary } from "../../src/postgres/locks.js";
import type { ReadView } from "../../src/server/ports.js";
import type { Level, NodeKind } from "../../src/types.js";

async function withHarness(work: (h: PgHarness) => Promise<void>) {
  const h = await createPgHarness();
  try { await work(h); } finally { await h.close(); }
}
async function ready(h: PgHarness, versionCode: string, isActive = false) {
  const id = await h.seedDataset({ status: "ready", versionCode, isActive });
  await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET import_report='{"passed":true}' WHERE id=$1`, [id]);
  return id;
}
async function node(h: PgHarness, datasetId: string, code: string, level: Level, parent: string | null = null,
  kind: NodeKind = "region", name = "同名") {
  return h.seedRegion(datasetId, { code, level, sourceName: name, nodeKind: kind, parentCode: null, ancestorCodes: [] }, parent);
}

it("keeps one repeatable-read snapshot for a request", async () => {
  await withHarness(async h => {
    const a = await ready(h, "a", true); const b = await ready(h, "b");
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    await store.read(async view => {
      expect((await view.resolveDataset({}))?.datasetId).toBe(a);
      await store.write(view2 => view2.setActive(b));
      expect((await view.resolveDataset({}))?.datasetId).toBe(a);
    });
    expect((await store.read(v => v.resolveDataset({})))?.datasetId).toBe(b);
  });
});

it("returns dataset-scoped five-level paths, duplicate names and batched missing codes", async () => {
  await withHarness(async h => {
    const a = await ready(h, "a"); const b = await ready(h, "b");
    let parent: string | null = null;
    for (const [index, code] of ["01", "93", "07", "81", "00009"].entries()) {
      parent = await node(h, a, code, (index + 1) as Level, parent);
    }
    await node(h, b, "00009", 1, null, "region", "另一版本");
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    await store.read(async view => {
      const paths = await view.getPaths(a, ["00009", "07", "missing", "00009"]);
      expect([...paths.keys()].sort()).toEqual(["00009", "07"]);
      expect(paths.get("00009")?.map(r => [r.code, r.level, r.parentCode])).toEqual([
        ["01", 1, null], ["93", 2, "01"], ["07", 3, "93"], ["81", 4, "07"], ["00009", 5, "81"],
      ]);
      expect(paths.get("07")?.map(r => r.sourceName)).toEqual(["同名", "同名", "同名"]);
      expect((await view.findNodes(a, ["00009", "missing", "01", "01"])).map(r => r.code).sort()).toEqual(["00009", "01"]);
      expect((await view.findNodes(b, ["00009"]))[0]?.sourceName).toBe("另一版本");
      expect(await view.findNodes(a, [])).toEqual([]);
      expect(await view.getPaths(a, [])).toEqual(new Map());
    });
  });
});

it("uses actual ancestors, literal search and sort/code keyset while retaining child groups", async () => {
  await withHarness(async h => {
    const id = await ready(h, "a"); const root = await node(h, id, "01", 1);
    const group = await node(h, id, "Z", 2, root, "group");
    await node(h, id, "a", 3, group, "region", "literal%_\\name");
    await node(h, id, "b", 3, group); await node(h, id, "c", 3, group);
    await node(h, id, "01-unrelated", 1);
    await h.pool.query(`UPDATE "${h.schemaName}".area_region SET sort=2 WHERE code IN ('b','c')`);
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    await store.read(async view => {
      expect((await view.listNodes(id, { parentCode: "01" }, null, 10)).map(r => r.code)).toEqual(["Z"]);
      expect((await view.listNodes(id, { ancestorCode: "01", level: 3 }, null, 2)).map(r => r.code)).toEqual(["a", "b"]);
      expect((await view.listNodes(id, { ancestorCode: "01", level: 3 }, { sort: 2, code: "b" }, 2)).map(r => r.code)).toEqual(["c"]);
      expect((await view.listNodes(id, { parentCode: null }, null, 10)).map(r => r.code)).toEqual(["01", "01-unrelated"]);
      expect((await view.listNodes(id, { keyword: "%_\\" }, null, 10)).map(r => r.code)).toEqual(["a"]);
      expect((await view.listNodes(id, { keyword: "01" }, null, 10)).map(r => r.code)).toEqual(["01", "01-unrelated"]);
      expect((await view.listNodes(id, { ancestorCode: "01", selectableOnly: true }, null, 10)).map(r => r.code)).toEqual(["a", "b", "c"]);
    });
  });
});

it("accounts for disabled ancestors and group navigation in batched child facts", async () => {
  await withHarness(async h => {
    const id = await ready(h, "a"); const root = await node(h, id, "root", 1);
    const group = await node(h, id, "group", 2, root, "group"); await node(h, id, "child", 3, group);
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    await store.read(async view => {
      expect(await view.getChildFacts(id, ["root", "group", "child", "missing"])).toEqual(new Map([
        ["root", { hasChildren: true, hasNavigableChildren: true }],
        ["group", { hasChildren: true, hasNavigableChildren: true }],
        ["child", { hasChildren: false, hasNavigableChildren: false }],
        ["missing", { hasChildren: false, hasNavigableChildren: false }],
      ]));
    });
    await store.write(view => view.updatePresentation(id, "root", 1, { enabled: false }));
    await store.read(async view => {
      expect(await view.listNodes(id, { selectableOnly: true }, null, 10)).toEqual([]);
      expect((await view.listNodes(id, { parentCode: "group" }, null, 10)).map(r => r.code)).toEqual(["child"]);
      expect((await view.getChildFacts(id, ["group"])).get("group"))
        .toEqual({ hasChildren: true, hasNavigableChildren: false });
      expect(await view.getChildFacts(id, [])).toEqual(new Map());
    });
  });
});

it("rejects malformed parent levels instead of returning a partial path", async () => {
  await withHarness(async h => {
    const id = await ready(h, "a"); const root = await node(h, id, "root", 1); await node(h, id, "bad", 3, root);
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    await expect(store.read(v => v.getPaths(id, ["bad"]))).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });
});

it("uses optimistic updates, rolls back failed callbacks and invalidates escaped views", async () => {
  await withHarness(async h => {
    const id = await ready(h, "a", true); const other = await ready(h, "b"); await node(h, id, "01", 1);
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    expect(await store.write(v => v.updatePresentation(id, "01", 1, { displayName: "别名", sort: 9 })))
      .toMatchObject({ sourceName: "同名", displayName: "别名", sort: 9, revision: 2 });
    await expect(store.write(v => v.updatePresentation(id, "01", 1, { enabled: false })))
      .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(store.write(async view => {
      await view.updatePresentation(id, "01", 2, { enabled: false }); await view.setActive(other);
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");
    let escaped: ReadView | undefined;
    await store.read(async view => {
      escaped = view;
      expect((await view.resolveDataset({}))?.datasetId).toBe(id);
      expect((await view.findNodes(id, ["01"]))[0]).toMatchObject({ enabled: true, revision: 2 });
      expect((await view.listNodes(id, { keyword: "别名" }, null, 10)).map(r => r.code)).toEqual(["01"]);
    });
    await expect(escaped!.findNodes(id, ["01"])).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(store.read(async () => { throw new Error("read failed"); })).rejects.toThrow("read failed");
    expect(h.pool.idleCount).toBe(h.pool.totalCount);
  });
});

it("only activates ready audited datasets and repeats the active target idempotently", async () => {
  await withHarness(async h => {
    const id = await ready(h, "a", true);
    const importing = await h.seedDataset(); const failed = await h.seedDataset({ status: "failed" });
    const unaudited = await h.seedDataset({ status: "ready" });
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    for (const target of [importing, failed, unaudited, "00000000-0000-0000-0000-000000000000"]) {
      await expect(store.write(v => v.setActive(target))).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
    }
    await store.write(v => v.setActive(id));
    expect((await store.read(v => v.resolveDataset({})))?.datasetId).toBe(id);
  });
});

it("binds reads to the caller transaction without committing and rejects bound writes", async () => {
  await withHarness(async h => {
    const id = await ready(h, "a"); await node(h, id, "01", 1);
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN"); await lockAreaLibrary(client, h.schemaName, "shared");
      await client.query(`UPDATE "${h.schemaName}".area_region SET display_name='uncommitted'`);
      const store = bindAreaStore(client, { schemaName: h.schemaName });
      let escaped: ReadView | undefined;
      await store.read(async view => {
        escaped = view; expect((await view.findNodes(id, ["01"]))[0]?.displayName).toBe("uncommitted");
      });
      await expect(escaped!.getLibraryKey()).rejects.toMatchObject({ code: "INVALID_CONFIG" });
      await expect(store.write(async () => undefined)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
      await client.query("ROLLBACK");
      expect((await h.pool.query(`SELECT display_name FROM "${h.schemaName}".area_region`)).rows[0].display_name).toBeNull();
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});

it("resolves explicit selectors and paginates dataset summaries without admin data", async () => {
  await withHarness(async h => {
    const a = await ready(h, "a", true); const b = await ready(h, "b");
    const c = await h.seedDataset({ versionCode: "c" });
    const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
    await store.read(async view => {
      expect((await view.resolveDataset({ datasetId: b, versionCode: "b" }))?.datasetId).toBe(b);
      expect(await view.resolveDataset({ datasetId: a, versionCode: "b" })).toBeNull();
      expect((await view.resolveDataset({ datasetId: c }))?.status).toBe("importing");
      const first = await view.listDatasets({ limit: 1 });
      expect(first.items.map(d => d.datasetId)).toEqual([a]);
      expect(first.hasMore).toBe(true); expect(first.nextCursor).toEqual(expect.any(String));
      expect(first.items[0]).not.toHaveProperty("report"); expect(first.items[0]).not.toHaveProperty("fileChecksums");
      const last = await view.listDatasets({ limit: 1, cursor: first.nextCursor! });
      expect(last.items.map(d => d.datasetId)).toEqual([b]); expect(last.hasMore).toBe(false); expect(last.nextCursor).toBeNull();
      expect((await view.listDatasets({ includeUnavailable: true })).items.map(d => d.datasetId)).toEqual([a, b, c]);
      await expect(view.listDatasets({ cursor: "bad" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(view.listDatasets({ limit: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(view.listDatasets({ includeUnavailable: true, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(await view.getLibraryKey()).toContain(h.schemaName);
      expect(await view.getLibraryKey()).toContain("area_kit_ephemeral_test");
    });
  });
});

it("takes the library write lock before reading state and observes the preceding commit", async () => {
  await withHarness(async h => {
    const a = await ready(h, "a", true); const b = await ready(h, "b");
    const client = await h.pool.connect();
    let pending: Promise<string | undefined> | undefined;
    try {
      await client.query("BEGIN"); await lockAreaLibrary(client, h.schemaName, "exclusive");
      await client.query(`UPDATE "${h.schemaName}".area_dataset SET is_active=false WHERE id=$1`, [a]);
      await client.query(`UPDATE "${h.schemaName}".area_dataset SET is_active=true WHERE id=$1`, [b]);
      const store = createDrizzleAreaStore(h.pool, { schemaName: h.schemaName });
      pending = store.write(async view => (await view.resolveDataset({}))?.datasetId);
      await expect.poll(async () => {
        const locks = await h.pool.query(`SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
        return locks.rows[0].waiting;
      }, { timeout: 5000 }).toBe(1);
      await client.query("COMMIT");
      expect(await pending).toBe(b);
    } finally { await client.query("ROLLBACK"); client.release(); await pending; }
  });
});

it("uses one shared library lock across clients and independent keys for different schemas", async () => {
  await withHarness(async h => {
    const first = await h.pool.connect(); const second = await h.pool.connect();
    try {
      await first.query("BEGIN"); await second.query("BEGIN");
      await lockAreaLibrary(first, h.schemaName, "shared");
      await lockAreaLibrary(second, h.schemaName, "shared");
      const observer = await h.pool.connect();
      try {
        await observer.query("BEGIN");
        const own = await observer.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [`area-kit:library:${h.schemaName}`]);
        expect(own.rows[0].acquired).toBe(false);
        await lockAreaLibrary(observer, `${h.schemaName}_other`, "exclusive");
        await observer.query("ROLLBACK");
      } finally { observer.release(); }
    } finally {
      await first.query("ROLLBACK"); await second.query("ROLLBACK"); first.release(); second.release();
    }
  });
});

it("targets public tables even when the connection search_path names a decoy library", async () => {
  const { areaMigrationSql } = await import("../../src/postgres/migration.js");
  await withHarness(async h => {
    const a = await ready(h, "public", false); await ready(h, "decoy", true);
    await h.pool.query(areaMigrationSql("public"));
    try {
      await h.pool.query(`INSERT INTO public.area_dataset SELECT * FROM "${h.schemaName}".area_dataset WHERE id=$1`, [a]);
      await h.pool.query("UPDATE public.area_dataset SET is_active=true");
      const client = await h.pool.connect();
      await client.query(`SET search_path TO "${h.schemaName}", public`); client.release();
      const store = createDrizzleAreaStore(h.pool);
      expect((await store.read(view => view.resolveDataset({})))?.datasetId).toBe(a);
      const bound = await h.pool.connect();
      try {
        await bound.query("BEGIN");
        expect((await bindAreaStore(bound).read(view => view.resolveDataset({})))?.datasetId).toBe(a);
        await bound.query("ROLLBACK");
        expect((await bound.query("SHOW search_path")).rows[0].search_path).toContain(h.schemaName);
      } finally { await bound.query("ROLLBACK"); bound.release(); }
    } finally { await h.pool.query("DROP TABLE public.area_region, public.area_dataset"); }
  });
});

it.each(["owned-read", "owned-write", "bound-read"] as const)(
  "keeps public dataset and region access ahead of temp decoys in %s", async mode => {
    const { areaMigrationSql } = await import("../../src/postgres/migration.js");
    await withHarness(async h => {
      const id = await ready(h, "public", true);
      await node(h, id, "01", 1, null, "region", "public region");
      await h.pool.query(areaMigrationSql("public"));
      try {
        await h.pool.query(`INSERT INTO public.area_dataset SELECT * FROM "${h.schemaName}".area_dataset`);
        await h.pool.query(`INSERT INTO public.area_region SELECT * FROM "${h.schemaName}".area_region`);
        const client = await h.pool.connect();
        await client.query("CREATE TEMP TABLE area_dataset AS SELECT * FROM public.area_dataset");
        await client.query("CREATE TEMP TABLE area_region AS SELECT * FROM public.area_region");
        await client.query("UPDATE pg_temp.area_dataset SET version_code='temp decoy'");
        await client.query("UPDATE pg_temp.area_region SET source_name='temp decoy'");
        const assertPublic = async (view: ReadView) => {
          expect((await view.resolveDataset({}))?.versionCode).toBe("public");
          expect((await view.findNodes(id, ["01"]))[0]?.sourceName).toBe("public region");
        };
        if (mode === "bound-read") {
          try {
            await client.query("BEGIN");
            await bindAreaStore(client).read(assertPublic);
          } finally { await client.query("ROLLBACK"); client.release(); }
        } else {
          // This harness has one pooled connection, carrying both session-local decoys.
          client.release();
          const store = createDrizzleAreaStore(h.pool);
          if (mode === "owned-read") await store.read(assertPublic);
          else {
            await store.write(async view => {
              await assertPublic(view);
              await view.updatePresentation(id, "01", 1, { displayName: "public update" });
            });
            expect((await h.pool.query("SELECT display_name FROM public.area_region")).rows[0].display_name)
              .toBe("public update");
            expect((await h.pool.query("SELECT display_name FROM pg_temp.area_region")).rows[0].display_name)
              .toBeNull();
          }
        }
      } finally { await h.pool.query("DROP TABLE public.area_region, public.area_dataset"); }
    });
  },
);
