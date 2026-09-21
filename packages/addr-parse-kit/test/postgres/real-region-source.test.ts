import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { activateDataset, areaMigrationSql, createDrizzleAreaStore } from "area-kit/postgres";
import { createAreaKit, type AreaKit } from "area-kit/server";
import { createAreaKitProvider, type AreaKitReadLike } from "../../examples/area-kit-provider.js";
import { initParser } from "../../src/server/index.js";
import { FIXTURE_NODES, countLevels } from "../fixtures.js";
import { isolatedPostgresConfig } from "./config.js";

/** 编译期证明：真实 AreaKit 实例可直接满足适配器的结构化读接口（不需要 area-kit 内部类型）。 */
function areaKitReadSurface<Ctx>(kit: AreaKit<Ctx>): AreaKitReadLike<Ctx> {
  return kit;
}

interface Ctx {
  readonly userId: string;
}

const ctx: Ctx = { userId: "addr-parse-kit-integration" };

let pool: Pool;
let schemaName: string;
let datasetId: string;
let versionCode: string;
let kit: AreaKit<Ctx>;

beforeAll(async () => {
  const config = isolatedPostgresConfig();
  pool = new Pool(config);
  const identity = await pool.query("SELECT current_database() AS database, current_user AS username");
  if (identity.rows[0].database !== config.database || identity.rows[0].username !== config.user) {
    throw new Error("拒绝在非一次性 PostgreSQL 连接上写入");
  }
  schemaName = `parse_kit_test_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE SCHEMA "${schemaName}"`);
  await pool.query(areaMigrationSql(schemaName));

  const store = createDrizzleAreaStore(pool, { schemaName });
  datasetId = randomUUID();
  versionCode = `synthetic-addr-parse:${datasetId}:v1`;
  // 区域数据用 area-kit 真实代码/名称（源自统计用区划代码），但只取够覆盖形态的极小子集。
  await pool.query(
    `INSERT INTO "${schemaName}".area_dataset
       (id, version_code, source, source_commit, rules_version, code_scheme, data_as_of, source_published_at,
        file_checksums, coverage, level_counts, status, is_active, import_report, imported_at)
     VALUES ($1,$2,'synthetic-test-only','synthetic-commit','synthetic-rules-v1','statistics-source-short-codes',
        '2023-06-30','2023-06-30',$3,$4,$5,'ready',false,$6,now())`,
    [
      datasetId,
      versionCode,
      JSON.stringify([{ name: "synthetic.csv", path: "synthetic.csv", level: 1, bytes: 0, sha256: "synthetic-test-checksum" }]),
      JSON.stringify({ levels: [1, 2, 3, 4, 5], excluded: [], description: "synthetic-test-only" }),
      JSON.stringify(countLevels(FIXTURE_NODES)),
      JSON.stringify({ passed: true, counts: {}, samples: [], sourceDigests: {}, databaseDigests: {}, inheritanceConflicts: 0 }),
    ],
  );
  const ids = new Map<string, string>();
  for (const node of FIXTURE_NODES) ids.set(node.code, randomUUID());
  for (const node of FIXTURE_NODES) {
    const parentId = node.parentCode === null ? null : ids.get(node.parentCode);
    if (node.parentCode !== null && !parentId) throw new Error(`fixture 父级缺失: ${node.parentCode}`);
    await pool.query(
      `INSERT INTO "${schemaName}".area_region (id, dataset_id, code, source_name, level, parent_id, node_kind, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ids.get(node.code), datasetId, node.code, node.name, node.level, parentId, node.kind, ids.size],
    );
  }
  const activated = await activateDataset(store, datasetId);
  versionCode = activated.versionCode;
  kit = createAreaKit<Ctx>({
    store,
    authorize: async (_ctx, request) => request.action === "read",
  });
});

afterAll(async () => {
  if (pool) await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`).catch(() => undefined);
  await pool?.end();
});

async function bootProvider(pageSize = 200) {
  const provider = createAreaKitProvider({ kit: areaKitReadSurface(kit), ctx, pageSize, aliases: { "15": ["内蒙古"] } });
  const parser = await initParser({ provider, datasetId, version: versionCode });
  return { provider, parser };
}

describe("真实区域包链路（area-kit + PostgreSQL）", () => {
  it("area-kit 数据集经 activate 后就绪，代码原样回读", async () => {
    const dataset = await kit.getDataset(ctx, { datasetId, versionCode });
    expect(dataset.status).toBe("ready");
    expect(dataset.codeScheme).toBe("statistics-source-short-codes");
    const region = await kit.getRegion(ctx, { datasetId, versionCode, code: "440305007" });
    expect(region.sourceName).toBe("粤海街道");
    expect(region.level).toBe(4);
  });

  it("适配器分多次分页拉满 1..4 级，第 5 级不进解析索引", async () => {
    const provider = createAreaKitProvider({ kit: areaKitReadSurface(kit), ctx, pageSize: 5, aliases: { "15": ["内蒙古"] } });
    const snapshot = await provider.loadSnapshot({ datasetId, version: versionCode });
    const expected = FIXTURE_NODES.filter((node) => node.level <= 4);
    const got = new Set(snapshot.nodes.map((node) => node.code));
    expect(expected.filter((node) => !got.has(node.code))).toEqual([]);
    expect(snapshot.nodes).toHaveLength(expected.length);
    expect(snapshot.nodes.every((node) => node.level <= 4)).toBe(true);
    expect(provider.stats()!.requests).toBeGreaterThan(expected.length / 5);
    expect(snapshot.nodes.find((node) => node.code === "15")?.aliases).toEqual(["内蒙古"]);
    console.info(`[integration] area-kit 冷启动统计（60 节点合成集，不代表生产规模）: ${JSON.stringify(provider.stats())}`);
  });

  it("用它初始化后解析真实地址，四级代码与 area-kit 路径一致", async () => {
    const { provider, parser } = await bootProvider();
    const candidate = parser.parse("广东省深圳市南山区粤海街道科技园南一路 8 栋 李四 13900139000").candidates[0]!;
    expect([candidate.province?.code, candidate.city?.code, candidate.district?.code, candidate.street?.code]).toEqual([
      "44",
      "4403",
      "440305",
      "440305007",
    ]);
    expect(candidate.detailedAddress).toContain("8 栋");
    expect(candidate.recipient).toMatchObject({ name: "李四", phone: "13900139000" });
    const path = await kit.getPath(ctx, { datasetId, versionCode, code: "440305007" });
    expect(path.pathCodes).toEqual([candidate.province!.code, candidate.city!.code, candidate.district!.code, candidate.street!.code]);
    expect(await provider.validatePath(path.pathCodes)).toMatchObject({ ok: true });
  });

  it("引擎不会用第二套数据：不在宿主快照内的区县不得被补出", async () => {
    const { parser } = await bootProvider();
    const candidate = parser.parse("江苏省南京市玄武区珠江路 100 号 王五 13700137000").candidates[0]!;
    expect(candidate.province?.code ?? null).toBe("32");
    expect(candidate.district).toBeNull();
    expect(candidate.status).not.toBe("matched");
    expect(candidate.residualText + candidate.detailedAddress).toContain("玄武区");
  });

  it("省直辖县级与跳层形态在真实数据下仍按真层级归位", async () => {
    const { parser } = await bootProvider();
    const candidate = parser.parse("湖北省仙桃市干河街道 大新路 5 号").candidates[0]!;
    expect(candidate.province?.code).toBe("42");
    expect(candidate.city).toBeNull();
    expect(candidate.district?.code).toBe("429004");
    expect(candidate.street?.code).toBe("429004002");
    expect(candidate.regionGroup?.code ?? "4290").toBe("4290");
  });

  it("同名城区仍出多候选且不预选", async () => {
    const { parser } = await bootProvider();
    const result = parser.parse("鼓楼区 中山北路 1 号");
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.requiresReview).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("AMBIGUOUS");
  });

  it("请求未知数据集时显式失败，不回退 active 或内置数据", async () => {
    const provider = createAreaKitProvider({ kit: areaKitReadSurface(kit), ctx });
    await expect(initParser({ provider, datasetId: randomUUID(), version: versionCode })).rejects.toMatchObject({ code: "E_REGION_INIT" });
    await expect(initParser({ provider, datasetId, version: "not-a-version" })).rejects.toMatchObject({ code: "E_REGION_INIT" });
  });

  it("批量链路逐条成功并保留 recordId", async () => {
    const { parser } = await bootProvider();
    const items = parser.parseBatch(
      ["北京市朝阳区建外街道 1 号楼 赵六 13600136000", "内蒙古自治区通辽市科尔沁区 民主路 2 号", "   "],
      {},
      ["rec-1", "rec-2", "rec-3"],
    );
    expect(items.map((item) => item.ok)).toEqual([true, true, false]);
    expect(items[2]!.error?.code).toBe("E_INPUT_EMPTY");
    expect(items[0]!.result!.candidates[0]!.district?.code).toBe("110105");
    expect(items[1]!.result!.candidates[0]!.province?.code).toBe("15");
  });

  it("真实 area-kit 语义下跳层会丢节点，完整性校验必须拦下", async () => {
    const streetCount = countLevels(FIXTURE_NODES)[4]!;
    const reparent = (parentCode: string) =>
      pool.query(
        `UPDATE "${schemaName}".area_region SET parent_id =
           (SELECT p.id FROM "${schemaName}".area_region p WHERE p.dataset_id = $1 AND p.code = $2)
         WHERE dataset_id = $1 AND code = '500103001'`,
        [datasetId, parentCode],
      );
    await reparent("5001");
    const provider = createAreaKitProvider({ kit: areaKitReadSurface(kit), ctx, pageSize: 5, aliases: { "15": ["内蒙古"] } });
    await expect(provider.loadSnapshot({ datasetId, version: versionCode })).rejects.toThrow(
      new RegExp(`第 4 级只取到 ${streetCount - 1} 个，数据集自报 ${streetCount} 个`),
    );
    await reparent("500103");
    const restored = await provider.loadSnapshot({ datasetId, version: versionCode });
    expect(restored.nodes.filter((node) => node.level === 4)).toHaveLength(streetCount);
  });
});
