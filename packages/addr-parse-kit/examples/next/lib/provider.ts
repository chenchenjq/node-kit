import { readFile } from "node:fs/promises";
import type { AdminLevel, NodeKind, PathCheck, RegionNode, RegionProvider, RegionSnapshot } from "addr-parse-kit";

/**
 * 宿主侧的离线快照 Provider（参考实现，不是 addr-parse-kit 的公开导出）。
 * addr-parse-kit 不内置区域数据：宿主用自己的区域来源实现 RegionProvider，
 * 这里演示最小可行版本 —— 读一个 JSON 快照文件，父级链校验路径。
 * 已经接入 area-kit 的宿主请改用 createAreaKitProvider（见 examples/area-kit-provider.ts）。
 */

const KINDS: readonly NodeKind[] = ["region", "group", "statisticalUnit", "unknown"];
const LEVELS: readonly AdminLevel[] = [1, 2, 3, 4, 5];

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`区域快照缺少合法的 ${field} 字段`);
  return value;
}

export function parseSnapshot(value: unknown): RegionSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("区域快照必须是 JSON 对象");
  const record = value as Record<string, unknown>;
  const datasetId = requiredString(record.datasetId, "datasetId");
  const version = requiredString(record.version, "version");
  const codeScheme = requiredString(record.codeScheme, "codeScheme");
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) throw new Error("区域快照 nodes 为空，拒绝加载（不回退到任何内置数据）");
  const seen = new Set<string>();
  const nodes: RegionNode[] = record.nodes.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`区域快照第 ${index} 个节点不是对象`);
    const node = item as Record<string, unknown>;
    const code = requiredString(node.code, `nodes[${index}].code`);
    if (seen.has(code)) throw new Error(`区域快照节点代码重复: ${code}`);
    seen.add(code);
    const name = requiredString(node.name, `nodes[${index}].name`);
    const level = node.level;
    if (typeof level !== "number" || !LEVELS.includes(level as AdminLevel)) throw new Error(`区域快照节点 ${code} 的 level 非法`);
    if (node.parentCode !== null && typeof node.parentCode !== "string") throw new Error(`区域快照节点 ${code} 的 parentCode 非法`);
    const kind = node.kind ?? "region";
    if (!KINDS.includes(kind as NodeKind)) throw new Error(`区域快照节点 ${code} 的 kind 非法: ${String(kind)}`);
    const aliases = node.aliases;
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string"))) {
      throw new Error(`区域快照节点 ${code} 的 aliases 非法`);
    }
    const sourceName = node.sourceName;
    if (sourceName !== undefined && typeof sourceName !== "string") throw new Error(`区域快照节点 ${code} 的 sourceName 非法`);
    return {
      code,
      name,
      level: level as AdminLevel,
      parentCode: (node.parentCode ?? null) as string | null,
      kind: kind as NodeKind,
      ...(typeof sourceName === "string" && sourceName ? { sourceName } : {}),
      ...(Array.isArray(aliases) && aliases.length ? { aliases: aliases as string[] } : {}),
    };
  });
  return { datasetId, version, codeScheme, nodes };
}

export async function readSnapshotFile(file: string): Promise<RegionSnapshot> {
  return parseSnapshot(JSON.parse(await readFile(file, "utf8")));
}

export interface SnapshotProvider extends RegionProvider {
  /** 演示用：示例页面需要按父级列出可选区域，真实宿主用自己的区域接口。 */
  childrenOf(parentCode: string | null): RegionNode[];
}

export function createSnapshotProvider(snapshot: RegionSnapshot, source = "demo-json-snapshot"): SnapshotProvider {
  const parentOf = new Map(snapshot.nodes.map((node) => [node.code, node.parentCode]));
  const byParent = new Map<string | null, RegionNode[]>();
  for (const node of snapshot.nodes) {
    const list = byParent.get(node.parentCode) ?? [];
    list.push(node);
    byParent.set(node.parentCode, list);
  }
  const selectable = (parentCode: string | null): RegionNode[] =>
    (byParent.get(parentCode) ?? []).filter((node) => node.kind !== "statisticalUnit").sort((a, b) => a.code.localeCompare(b.code));

  async function loadSnapshot(requested: { datasetId: string; version: string }): Promise<RegionSnapshot> {
    // 版本不一致时按快照真实身份返回，让 addr-parse-kit 抛 E_REGION_VERSION_MISMATCH；宿主不静默换数据。
    return snapshot;
  }

  async function validatePath(codes: readonly (string | null)[]): Promise<PathCheck> {
    const filled = codes.filter((code): code is string => typeof code === "string" && code.length > 0);
    if (!filled.length) return { ok: false, problems: [{ code: "", reason: "未提供任何区域代码" }] };
    const deepest = filled[filled.length - 1]!;
    const chain = new Set<string>();
    let cursor: string | null | undefined = deepest;
    while (cursor !== undefined) {
      chain.add(cursor);
      if (!parentOf.has(cursor)) return { ok: false, problems: [{ code: cursor, reason: `${cursor} 不在区域快照中` }] };
      cursor = parentOf.get(cursor) ?? undefined;
    }
    const problems = filled
      .filter((code) => !chain.has(code))
      .map((code) => ({ code, reason: `${code} 不是 ${deepest} 的上级` }));
    return { ok: problems.length === 0, problems };
  }

  return { source, loadSnapshot, validatePath, childrenOf: (parentCode) => selectable(parentCode) };
}
