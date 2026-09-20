import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createAreaKitProvider,
  createJsonSnapshotProvider,
  parseRegionSnapshot,
  type AreaKitReadLike,
  type AreaKitRegionLike,
} from "../examples/area-kit-provider.js";
import { initParser } from "../src/server/index.js";
import { FIXTURE_NODES, countLevels, fixtureSnapshot } from "./fixtures.js";
import type { AdminLevel, RegionNode, RegionSnapshot } from "../src/types.js";

const run = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface FakeKitOptions {
  pageSize?: number;
  brokenCursor?: boolean;
  status?: "importing" | "ready" | "failed";
  levelCounts?: Partial<Record<AdminLevel, number>>;
}

function makeKit(nodes: readonly RegionNode[], options: FakeKitOptions & { datasetId: string; versionCode: string }) {
  const { datasetId, versionCode } = options;
  const calls = { listRegions: 0, getDataset: 0, getPath: 0 };
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const levelCounts: Partial<Record<AdminLevel, number>> = options.levelCounts ?? countLevels(nodes);
  const toRow = (node: RegionNode): AreaKitRegionLike => ({
    code: node.code,
    sourceName: node.sourceName ?? node.name,
    label: node.name,
    level: node.level,
    parentCode: node.parentCode,
    nodeKind: node.kind,
    effectiveEnabled: true,
  });
  const chainOf = (code: string): string[] => {
    const chain: string[] = [];
    let current = byCode.get(code);
    while (current) {
      chain.unshift(current.code);
      current = current.parentCode === null ? undefined : byCode.get(current.parentCode);
    }
    return chain;
  };
  /** area-kit 的后代查询要求父子层级逐级 +1，跳层节点经 ancestorCode 是不可达的。 */
  const reachableAncestors = (code: string): string[] => {
    const chain: string[] = [];
    let expectedLevel = (byCode.get(code)?.level ?? 0) - 1;
    let parentCode = byCode.get(code)?.parentCode ?? null;
    while (parentCode !== null) {
      const parent = byCode.get(parentCode);
      if (!parent || parent.level !== expectedLevel) break;
      chain.unshift(parent.code);
      expectedLevel -= 1;
      parentCode = parent.parentCode;
    }
    return chain;
  };
  const kit: AreaKitReadLike<unknown> = {
    async getDataset(_ctx, selector) {
      calls.getDataset += 1;
      if (selector.datasetId !== datasetId || selector.versionCode !== versionCode) throw new Error("VERSION_UNAVAILABLE");
      return { datasetId, versionCode, codeScheme: "statistics-source-short-codes", levelCounts, status: options.status ?? "ready" };
    },
    async listRegions(_ctx, input) {
      calls.listRegions += 1;
      if (input.limit !== undefined && input.limit > 200) throw new Error("INVALID_ARGUMENT");
      let rows = [...nodes];
      if (input.level !== undefined) rows = rows.filter((node) => node.level === input.level);
      if (input.ancestorCode !== undefined) {
        const ancestor = input.ancestorCode;
        rows = rows.filter((node) => reachableAncestors(node.code).includes(ancestor));
      }
      const sorted = rows.map(toRow).sort((a, b) => (a.code < b.code ? -1 : 1));
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      if (!Number.isInteger(offset) || offset < 0) throw new Error("BAD_CURSOR");
      const limit = input.limit ?? 50;
      const items = sorted.slice(offset, offset + limit);
      const hasMore = offset + items.length < sorted.length;
      return { items, hasMore, nextCursor: hasMore ? (options.brokenCursor ? null : String(offset + items.length)) : null };
    },
    async getPath(_ctx, input) {
      calls.getPath += 1;
      if (!byCode.has(input.code)) throw new Error("UNKNOWN_CODE");
      return { pathCodes: chainOf(input.code) };
    },
  };
  return { kit, calls };
}

/** 每个用例用新的 datasetId/version，避免命中 addr-parse-kit 的进程级索引缓存（缓存复用由 core.test 覆盖）。 */
let sequence = 0;

function areaKitProvider(
  options: FakeKitOptions & { nodes?: readonly RegionNode[]; levels?: readonly AdminLevel[] } = {},
) {
  sequence += 1;
  const datasetId = `adapter-ds-${sequence}`;
  const version = `adapter-v${sequence}`;
  const { kit, calls } = makeKit(options.nodes ?? FIXTURE_NODES, { ...options, datasetId, versionCode: version });
  const provider = createAreaKitProvider({
    kit,
    ctx: undefined,
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.levels === undefined ? {} : { levels: options.levels }),
  });
  return { calls, datasetId, version, provider };
}

const NODES_UP_TO_STREET = FIXTURE_NODES.filter((node) => node.level <= 4);

describe("area-kit 适配：全量拉取", () => {
  it("按 1..4 级分页拉全，第 5 级不进快照", async () => {
    const { provider, calls, datasetId, version } = areaKitProvider({ pageSize: 3 });
    const snapshot = await provider.loadSnapshot({ datasetId, version });
    expect(snapshot.nodes.map((node) => node.code).sort()).toEqual(NODES_UP_TO_STREET.map((node) => node.code).sort());
    expect(snapshot.nodes.some((node) => node.level === 5)).toBe(false);
    expect(snapshot.codeScheme).toBe("statistics-source-short-codes");
    expect(calls.listRegions).toBe(provider.stats()!.requests);
    expect(calls.listRegions).toBeGreaterThan(20);
    expect(provider.stats()!.nodes).toBe(NODES_UP_TO_STREET.length);
  });

  it("匹配名取宿主 label，原始名保留在 sourceName", async () => {
    const { provider, datasetId, version } = areaKitProvider();
    const snapshot = await provider.loadSnapshot({ datasetId, version });
    const province = snapshot.nodes.find((node) => node.code === "44")!;
    expect(province.name).toBe("广东省");
    expect(province.sourceName).toBe("广东省");
    expect(province.parentCode).toBe(null);
  });

  it("宿主别名随快照下发", async () => {
    const { kit } = makeKit(FIXTURE_NODES, { datasetId: "alias-ds", versionCode: "alias-v" });
    const provider = createAreaKitProvider({ kit, ctx: undefined, aliases: { "15": ["内蒙古"] } });
    const snapshot = await provider.loadSnapshot({ datasetId: "alias-ds", version: "alias-v" });
    expect(snapshot.nodes.find((node) => node.code === "15")!.aliases).toEqual(["内蒙古"]);
  });

  it("levels 可截断到区县以下", async () => {
    const { provider, datasetId, version } = areaKitProvider({ levels: [1, 2, 3] });
    const snapshot = await provider.loadSnapshot({ datasetId, version });
    expect(snapshot.nodes.every((node) => node.level <= 3)).toBe(true);
  });

  it("拒绝没有省级的 levels", () => {
    const { kit } = makeKit(FIXTURE_NODES, { datasetId: "d", versionCode: "v" });
    expect(() => createAreaKitProvider({ kit, ctx: undefined, levels: [2, 3] })).toThrow(RangeError);
  });

  it("拒绝超出 area-kit 上限的 pageSize", () => {
    const { kit } = makeKit(FIXTURE_NODES, { datasetId: "d", versionCode: "v" });
    expect(() => createAreaKitProvider({ kit, ctx: undefined, pageSize: 500 })).toThrow(RangeError);
  });
});

describe("area-kit 适配：版本与故障必须显式失败", () => {
  it("请求的数据集不存在时抛错，不回退 active", async () => {
    const { provider, version } = areaKitProvider();
    await expect(provider.loadSnapshot({ datasetId: "no-such-ds", version })).rejects.toThrow("VERSION_UNAVAILABLE");
  });

  it("数据集未就绪时拒绝建索引", async () => {
    const { provider, datasetId, version } = areaKitProvider({ status: "importing" });
    await expect(provider.loadSnapshot({ datasetId, version })).rejects.toThrow("状态为 importing");
  });

  it("hasMore 却缺游标时报错而非静默截断", async () => {
    const { provider, datasetId, version } = areaKitProvider({ pageSize: 3, brokenCursor: true });
    await expect(provider.loadSnapshot({ datasetId, version })).rejects.toThrow("游标");
  });

  it("跳层数据集会被完整性交叉校验挡下（不静默丢节点）", async () => {
    const streetCount = FIXTURE_NODES.filter((node) => node.level === 4).length;
    const gapped = FIXTURE_NODES.map((node) => (node.code === "500103001" ? { ...node, parentCode: "5001" } : node));
    const { provider, datasetId, version } = areaKitProvider({ nodes: gapped });
    await expect(provider.loadSnapshot({ datasetId, version })).rejects.toThrow(
      new RegExp(`第 4 级只取到 ${streetCount - 1} 个，数据集自报 ${streetCount} 个`),
    );
  });

  it("数据集未自报分级行数时拒绝初始化", async () => {
    const { provider, datasetId, version } = areaKitProvider({ levelCounts: {} });
    await expect(provider.loadSnapshot({ datasetId, version })).rejects.toThrow(/未自报第 1 级行数/);
  });

  it("适配后的 Provider 可直接 initParser 并解析", async () => {
    const { provider, datasetId, version } = areaKitProvider();
    const parser = await initParser({ provider, datasetId, version });
    const result = parser.parse("广东省深圳市南山区粤海街道科技园 1 栋 张三 13800138000");
    const candidate = result.candidates[0]!;
    expect([candidate.province?.code, candidate.city?.code, candidate.district?.code, candidate.street?.code]).toEqual([
      "44",
      "4403",
      "440305",
      "440305007",
    ]);
    expect(candidate.detailedAddress).toContain("科技园");
    expect(candidate.recipient?.name).toBe("张三");
    expect(parser.meta.regionSource).toBe("area-kit");
  });

  it("Provider 加载失败经 initParser 变成 E_REGION_INIT", async () => {
    const { provider, datasetId, version } = areaKitProvider({ status: "failed" });
    await expect(initParser({ provider, datasetId, version })).rejects.toMatchObject({ code: "E_REGION_INIT" });
  });
});

describe("area-kit 适配：validatePath 走真实层级链", () => {
  it("快照未加载时不可校验", async () => {
    const { provider } = areaKitProvider();
    await expect(provider.validatePath(["44", "4403"])).resolves.toMatchObject({ ok: false });
  });

  it("合法下钻通过，空洞层级也通过", async () => {
    const { provider, datasetId, version } = areaKitProvider();
    await provider.loadSnapshot({ datasetId, version });
    expect(await provider.validatePath(["44", "4403", "440305", "440305007"])).toMatchObject({ ok: true });
    expect(await provider.validatePath(["44", null, "440305", null])).toMatchObject({ ok: true });
  });

  it("跨分支归因到非祖先代码，未知代码被拒", async () => {
    const { provider, datasetId, version } = areaKitProvider();
    await provider.loadSnapshot({ datasetId, version });
    const cross = await provider.validatePath(["44", "4403", "610113"]);
    expect(cross.ok).toBe(false);
    expect(cross.problems.map((problem) => problem.code).sort()).toEqual(["44", "4403"]);
    const unknown = await provider.validatePath(["44", "9999"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.problems[0]!.code).toBe("9999");
  });

  it("空选择被拒", async () => {
    const { provider, datasetId, version } = areaKitProvider();
    await provider.loadSnapshot({ datasetId, version });
    await expect(provider.validatePath([null, null])).resolves.toMatchObject({ ok: false });
  });
});

describe("JSON 快照 Provider", () => {
  let jsonSequence = 0;

  async function snapshotFile(overrides: Partial<RegionSnapshot> = {}): Promise<{ file: string; datasetId: string; version: string }> {
    jsonSequence += 1;
    const datasetId = `json-ds-${jsonSequence}`;
    const version = `json-v${jsonSequence}`;
    const dir = await mkdtemp(join(tmpdir(), "addr-parse-kit-"));
    const file = join(dir, "snapshot.json");
    await writeFile(file, JSON.stringify({ ...fixtureSnapshot(), ...overrides, datasetId, version }), "utf8");
    return { file, datasetId, version };
  }

  it("离线快照可完成解析与校验", async () => {
    const { file, datasetId, version } = await snapshotFile();
    const provider = createJsonSnapshotProvider({ file });
    const parser = await initParser({ provider, datasetId, version });
    const candidate = parser.parse("云南省红河哈尼族彝族自治州蒙自市文澜街道 1 号").candidates[0]!;
    expect(candidate.province?.code).toBe("53");
    expect(candidate.district?.code).toBe("532503");
    expect(await provider.validatePath(["53", "5325", "532503"])).toMatchObject({ ok: true });
    expect(await provider.validatePath(["53", "6101"])).toMatchObject({ ok: false });
    expect(provider.stats()!.nodes).toBe(FIXTURE_NODES.length);
  });

  it("快照版本与请求不一致时报版本冲突", async () => {
    const { file, datasetId } = await snapshotFile();
    const provider = createJsonSnapshotProvider({ file });
    await expect(initParser({ provider, datasetId, version: "not-the-file-version" })).rejects.toMatchObject({
      code: "E_REGION_VERSION_MISMATCH",
    });
  });

  it("快照父级缺失时在建索引阶段失败", async () => {
    const { file, datasetId, version } = await snapshotFile({ nodes: FIXTURE_NODES.filter((node) => node.code !== "4403") });
    const provider = createJsonSnapshotProvider({ file });
    await expect(initParser({ provider, datasetId, version })).rejects.toMatchObject({ code: "E_SNAPSHOT_INVALID" });
  });

  it("parseRegionSnapshot 拒绝结构非法的快照", () => {
    expect(() => parseRegionSnapshot([])).toThrow(/对象/);
    expect(() => parseRegionSnapshot({ datasetId: "d", version: "v", codeScheme: "c", nodes: "x" })).toThrow(/nodes/);
    expect(() =>
      parseRegionSnapshot({
        datasetId: "d",
        version: "v",
        codeScheme: "c",
        nodes: [
          { code: "11", name: "北京市", level: 1, parentCode: null },
          { code: "11", name: "北京市", level: 1, parentCode: null },
        ],
      }),
    ).toThrow(/重复/);
    expect(() =>
      parseRegionSnapshot({ datasetId: "d", version: "v", codeScheme: "c", nodes: [{ code: "11", name: "北京市", level: 9, parentCode: null }] }),
    ).toThrow(/level/);
  });
});

describe("export-snapshot 脚本", () => {
  it("从宿主 Provider 导出快照文件并带统计", async () => {
    const dir = await mkdtemp(join(tmpdir(), "addr-parse-kit-export-"));
    const sourceFile = join(dir, "source.json");
    await writeFile(sourceFile, JSON.stringify(fixtureSnapshot()), "utf8");
    const providerFile = join(dir, "provider.mjs");
    await writeFile(
      providerFile,
      `import { readFile } from "node:fs/promises";
const file = ${JSON.stringify(sourceFile)};
export default {
  source: "area-kit",
  async loadSnapshot() { return JSON.parse(await readFile(file, "utf8")); },
  async validatePath() { return { ok: true, problems: [] }; },
  stats() { return { datasetId: "fixture-ds", version: "fixture-v1", nodes: 1, requests: 7, coldStartMs: 12 }; },
};
`,
      "utf8",
    );
    const outFile = join(dir, "out", "snapshot.json");
    await run(process.execPath, [
      join(PACKAGE_ROOT, "scripts", "export-snapshot.mjs"),
      "--provider",
      providerFile,
      "--dataset-id",
      "fixture-ds",
      "--version",
      "fixture-v1",
      "--out",
      outFile,
    ]);
    const payload = JSON.parse(await readFile(outFile, "utf8"));
    expect(payload.datasetId).toBe("fixture-ds");
    expect(payload.version).toBe("fixture-v1");
    expect(payload.nodeCount).toBe(FIXTURE_NODES.length);
    expect(payload.stats.requests).toBe(7);
    expect(payload.levelCounts[4]).toBeGreaterThan(0);
    const exported = createJsonSnapshotProvider({ file: outFile });
    const parser = await initParser({ provider: exported, datasetId: "fixture-ds", version: "fixture-v1" });
    expect(parser.parse("陕西省西安市雁塔区小寨路 3 号").candidates[0]!.province?.code).toBe("61");
  });

  it("请求版本与 Provider 返回不一致时拒绝导出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "addr-parse-kit-export-bad-"));
    const providerFile = join(dir, "provider.mjs");
    await writeFile(
      providerFile,
      `export default {
  source: "x",
  async loadSnapshot() { return { datasetId: "a", version: "b", codeScheme: "c", nodes: [{ code: "11", name: "北京市", level: 1, parentCode: null }] }; },
  async validatePath() { return { ok: true, problems: [] }; },
};`,
      "utf8",
    );
    const failure = await run(process.execPath, [
      join(PACKAGE_ROOT, "scripts", "export-snapshot.mjs"),
      "--provider",
      providerFile,
      "--dataset-id",
      "a",
      "--version",
      "z",
      "--out",
      join(dir, "out.json"),
    ])
      .then(() => null)
      .catch((error: Error & { stderr?: string }) => error);
    expect(failure).not.toBeNull();
    expect(`${failure?.stderr ?? ""}${failure?.message ?? ""}`).toMatch(/与请求/);
  });
});
