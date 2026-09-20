import { readFile } from "node:fs/promises";
import type { AdminLevel, NodeKind, PathCheck, RegionNode, RegionProvider, RegionSnapshot } from "addr-parse-kit";

/**
 * 参考实现：把宿主已有的区域包（area-kit 公开读接口）适配成 addr-parse-kit 的 RegionProvider。
 * 本文件不是包的公开导出，宿主可整体复制后按自己的鉴权与数据集选择改造。
 * 这里刻意只用结构化类型描述 area-kit，因此宿主未安装 area-kit 时本文件也能通过类型检查。
 */

const AREA_KIT_MAX_PAGE_SIZE = 200;

export interface AreaKitRegionLike {
  readonly code: string;
  readonly sourceName: string;
  readonly label: string;
  readonly level: AdminLevel;
  readonly parentCode: string | null;
  readonly nodeKind: NodeKind;
  readonly effectiveEnabled: boolean;
}

export interface AreaKitPageLike<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface AreaKitDatasetLike {
  readonly datasetId: string;
  readonly versionCode: string;
  readonly codeScheme: string;
  readonly status: "importing" | "ready" | "failed";
  /** area-kit 自报的分级行数，用于交叉核对快照完整性（缺失即无法证明拉全，直接拒绝初始化）。 */
  readonly levelCounts: Partial<Record<AdminLevel, number>>;
}

export interface AreaKitListInputLike {
  readonly datasetId: string;
  readonly versionCode: string;
  readonly level?: AdminLevel;
  readonly ancestorCode?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AreaKitPathLike {
  readonly pathCodes: readonly string[];
}

/** area-kit 的祖先子树查询要求父子层级连续（child.level = parent.level + 1）。 */
export interface AreaKitReadLike<Ctx> {
  getDataset(ctx: Ctx, selector: { datasetId: string; versionCode: string }): Promise<AreaKitDatasetLike>;
  listRegions(ctx: Ctx, input: AreaKitListInputLike): Promise<AreaKitPageLike<AreaKitRegionLike>>;
  getPath(ctx: Ctx, input: { datasetId: string; versionCode: string; code: string }): Promise<AreaKitPathLike>;
}

export interface SnapshotStats {
  readonly datasetId: string;
  readonly version: string;
  readonly nodes: number;
  readonly requests: number;
  readonly coldStartMs: number;
}

export interface AreaKitProviderOptions<Ctx> {
  kit: AreaKitReadLike<Ctx>;
  ctx: Ctx;
  /** 默认 1..4：第五级（村/社区）数量庞大且解析引擎不使用。 */
  levels?: readonly AdminLevel[];
  pageSize?: number;
  /** 宿主自定义别名字典，键为区域代码（如 { "15": ["内蒙古"] }）。 */
  aliases?: Readonly<Record<string, readonly string[]>>;
  onProgress?: (info: { phase: string; nodes: number; requests: number; elapsedMs: number }) => void;
}

export interface HostRegionProvider extends RegionProvider {
  stats(): SnapshotStats | null;
}

export function createAreaKitProvider<Ctx>(options: AreaKitProviderOptions<Ctx>): HostRegionProvider {
  const levels = [...(options.levels ?? [1, 2, 3, 4])].sort((a, b) => a - b);
  if (!levels.length || levels[0] !== 1) throw new RangeError("levels 必须包含 1（省级），否则无法构建区域树");
  const pageSize = options.pageSize ?? AREA_KIT_MAX_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > AREA_KIT_MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize 必须是 1..${AREA_KIT_MAX_PAGE_SIZE} 的整数（area-kit 接口硬上限）`);
  }
  let stats: SnapshotStats | null = null;
  let loaded: { datasetId: string; versionCode: string } | null = null;

  async function loadSnapshot(input: { datasetId: string; version: string }): Promise<RegionSnapshot> {
    const started = Date.now();
    let requests = 0;
    const dataset = await options.kit.getDataset(options.ctx, { datasetId: input.datasetId, versionCode: input.version });
    if (dataset.datasetId !== input.datasetId || dataset.versionCode !== input.version) {
      throw new Error(`area-kit 返回数据集 ${dataset.datasetId}/${dataset.versionCode}，与请求 ${input.datasetId}/${input.version} 不一致`);
    }
    if (dataset.status !== "ready") throw new Error(`数据集 ${input.datasetId}/${input.version} 状态为 ${dataset.status}，拒绝构建索引`);

    async function collect(base: Omit<AreaKitListInputLike, "limit" | "cursor">): Promise<AreaKitRegionLike[]> {
      const collected: AreaKitRegionLike[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await options.kit.listRegions(options.ctx, {
          ...base,
          limit: pageSize,
          ...(cursor === undefined ? {} : { cursor }),
        });
        requests += 1;
        collected.push(...page.items);
        if (!page.hasMore) return collected;
        if (page.nextCursor === null) throw new Error(`区域分页 hasMore=true 但缺少游标（${JSON.stringify(base)}）`);
        cursor = page.nextCursor;
      }
    }

    const selector = { datasetId: input.datasetId, versionCode: input.version };
    const nodes: RegionNode[] = [];
    const seen = new Set<string>();
    const perLevel = new Map<AdminLevel, number>();
    const add = (rows: readonly AreaKitRegionLike[]): void => {
      for (const row of rows) {
        if (seen.has(row.code)) continue;
        seen.add(row.code);
        const aliases = options.aliases?.[row.code];
        nodes.push({
          code: row.code,
          name: row.label || row.sourceName,
          sourceName: row.sourceName,
          level: row.level,
          parentCode: row.parentCode,
          kind: row.nodeKind,
          ...(aliases?.length ? { aliases } : {}),
        });
        perLevel.set(row.level, (perLevel.get(row.level) ?? 0) + 1);
      }
    };

    const provinces = await collect({ ...selector, level: 1 });
    add(provinces);
    for (const level of levels.slice(1)) {
      for (const province of provinces) {
        add(await collect({ ...selector, ancestorCode: province.code, level }));
      }
      options.onProgress?.({
        phase: `level:${level}`,
        nodes: nodes.length,
        requests,
        elapsedMs: Date.now() - started,
      });
    }
    if (!nodes.length) throw new Error(`数据集 ${input.datasetId}/${input.version} 未取到任何区域节点`);

    // area-kit 的 ancestorCode 子树查询要求父子层级连续；数据集一旦出现跳层，按省分级拉取会静默丢节点，
    // 所以必须用数据集自报的分级行数交叉核对，宁可启动失败也不交出残缺的区域索引。
    for (const level of levels) {
      const expected = dataset.levelCounts[level];
      if (expected === undefined) {
        throw new Error(`数据集 ${input.datasetId}/${input.version} 未自报第 ${level} 级行数，无法确认快照是否拉全（拒绝初始化）`);
      }
      const actual = perLevel.get(level) ?? 0;
      if (actual !== expected) {
        throw new Error(
          `区域快照第 ${level} 级只取到 ${actual} 个，数据集自报 ${expected} 个（${input.datasetId}/${input.version}）：` +
            `数据集存在跳层或不可经 ancestorCode 到达的节点，需改用逐父级 BFS 拉取`,
        );
      }
    }

    stats = { datasetId: input.datasetId, version: input.version, nodes: nodes.length, requests, coldStartMs: Date.now() - started };
    loaded = { datasetId: input.datasetId, versionCode: input.version };
    return { datasetId: input.datasetId, version: input.version, codeScheme: dataset.codeScheme, nodes };
  }

  async function validatePath(codes: readonly (string | null)[]): Promise<PathCheck> {
    if (!loaded) return { ok: false, problems: [{ code: "", reason: "区域快照尚未加载，无法校验层级" }] };
    const filled = codes.filter((code): code is string => typeof code === "string" && code.length > 0);
    if (!filled.length) return { ok: false, problems: [{ code: "", reason: "未提供任何区域代码" }] };
    const deepest = filled[filled.length - 1]!;
    let pathCodes: readonly string[];
    try {
      ({ pathCodes } = await options.kit.getPath(options.ctx, { ...loaded, code: deepest }));
    } catch (cause) {
      return { ok: false, problems: [{ code: deepest, reason: `area-kit getPath 失败: ${String(cause)}` }] };
    }
    const problems: { code: string; reason: string }[] = [];
    let previous = -1;
    for (const code of filled) {
      const position = pathCodes.indexOf(code);
      if (position < 0) problems.push({ code, reason: `${code} 不在 ${deepest} 的区域路径上` });
      else if (position <= previous) problems.push({ code, reason: `${code} 与前面的选择不是逐级下钻关系` });
      else previous = position;
    }
    return { ok: problems.length === 0, problems };
  }

  return { source: "area-kit", loadSnapshot, validatePath, stats: () => stats };
}

export function parseRegionSnapshot(value: unknown): RegionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("快照文件必须是 JSON 对象");
  const record = value as Record<string, unknown>;
  const { datasetId, version, codeScheme } = record;
  if (typeof datasetId !== "string" || !datasetId) throw new Error("快照缺少 datasetId");
  if (typeof version !== "string" || !version) throw new Error("快照缺少 version");
  if (typeof codeScheme !== "string" || !codeScheme) throw new Error("快照缺少 codeScheme");
  if (!Array.isArray(record.nodes)) throw new Error("快照 nodes 必须是数组");
  const nodes: RegionNode[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (record.nodes as unknown[]).entries()) {
    if (typeof item !== "object" || item === null) throw new Error(`快照第 ${index} 个节点不是对象`);
    const node = item as Record<string, unknown>;
    if (typeof node.code !== "string" || !node.code) throw new Error(`快照第 ${index} 个节点缺少 code`);
    if (seen.has(node.code)) throw new Error(`快照节点代码重复: ${node.code}`);
    seen.add(node.code);
    if (typeof node.name !== "string" || !node.name) throw new Error(`快照节点 ${node.code} 缺少 name`);
    if (typeof node.level !== "number" || !Number.isInteger(node.level) || node.level < 1 || node.level > 5) {
      throw new Error(`快照节点 ${node.code} 的 level 非法: ${String(node.level)}`);
    }
    if (node.parentCode !== null && typeof node.parentCode !== "string") throw new Error(`快照节点 ${node.code} 的 parentCode 非法`);
    const kind = node.kind ?? "region";
    if (kind !== "region" && kind !== "group" && kind !== "statisticalUnit" && kind !== "unknown") {
      throw new Error(`快照节点 ${node.code} 的 kind 非法: ${String(kind)}`);
    }
    const aliases = node.aliases;
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string"))) {
      throw new Error(`快照节点 ${node.code} 的 aliases 非法`);
    }
    const sourceName = node.sourceName;
    if (sourceName !== undefined && typeof sourceName !== "string") throw new Error(`快照节点 ${node.code} 的 sourceName 非法`);
    nodes.push({
      code: node.code,
      name: node.name,
      level: node.level as AdminLevel,
      parentCode: (node.parentCode ?? null) as string | null,
      kind,
      ...(typeof sourceName === "string" && sourceName ? { sourceName } : {}),
      ...(Array.isArray(aliases) && aliases.length ? { aliases: aliases as string[] } : {}),
    });
  }
  return { datasetId, version, codeScheme, nodes };
}

export interface JsonSnapshotProviderOptions {
  file: string;
  /** 快照里 area-kit 的 sourceName 缺失时的兜底显示名来源，一般不需要。 */
  source?: string;
}

/** 离线快照 Provider：预导出 JSON，冷启动只做一次读文件，适合进程/worker 反复初始化的场景。 */
export function createJsonSnapshotProvider(options: JsonSnapshotProviderOptions): HostRegionProvider {
  let cached: RegionSnapshot | null = null;
  let stats: SnapshotStats | null = null;
  let parents: Map<string, string | null> | null = null;

  async function loadSnapshot(input: { datasetId: string; version: string }): Promise<RegionSnapshot> {
    if (!cached) {
      const started = Date.now();
      const text = await readFile(options.file, "utf8");
      const snapshot = parseRegionSnapshot(JSON.parse(text));
      parents = new Map(snapshot.nodes.map((node) => [node.code, node.parentCode]));
      cached = snapshot;
      stats = { datasetId: snapshot.datasetId, version: snapshot.version, nodes: snapshot.nodes.length, requests: 0, coldStartMs: Date.now() - started };
    }
    // 版本不一致时按快照真实身份返回，由 addr-parse-kit 抛 E_REGION_VERSION_MISMATCH，不在这里静默换数据。
    return cached;
  }

  async function validatePath(codes: readonly (string | null)[]): Promise<PathCheck> {
    const problems: { code: string; reason: string }[] = [];
    const filled = codes.filter((code): code is string => typeof code === "string" && code.length > 0);
    if (!filled.length) return { ok: false, problems: [{ code: "", reason: "未提供任何区域代码" }] };
    const chain = parents ?? new Map<string, string | null>();
    const deepest = filled[filled.length - 1]!;
    const ancestry = new Set<string>();
    let cursor: string | null = deepest;
    while (cursor !== null) {
      ancestry.add(cursor);
      if (!chain.has(cursor)) {
        problems.push({ code: cursor, reason: `${cursor} 不在快照中` });
        break;
      }
      cursor = chain.get(cursor) ?? null;
    }
    for (const code of filled) {
      if (code === deepest) continue;
      if (!ancestry.has(code)) problems.push({ code, reason: `${code} 不是 ${deepest} 的祖先` });
    }
    return { ok: problems.length === 0, problems };
  }

  return { source: options.source ?? "snapshot-json", loadSnapshot, validatePath, stats: () => stats };
}
