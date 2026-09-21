import { ParseKitError } from "../errors.js";
import type { AdminLevel, NodeKind, RegionSnapshot } from "../types.js";

export interface DivisionTreeInput {
  code: string;
  name: string;
  children?: DivisionTreeInput[];
}

export interface RegionIndex {
  byCode: ReadonlyMap<string, { name: string; sourceName: string; level: AdminLevel; parentCode: string | null; kind: NodeKind }>;
  names: ReadonlySet<string>;
  divisions: DivisionTreeInput[];
  aliases: Record<string, string[]>;
  datasetId: string;
  version: string;
  codeScheme: string;
}

interface MutableNode {
  code: string;
  name: string;
  sourceName: string;
  level: AdminLevel;
  parentCode: string | null;
  kind: NodeKind;
  children: MutableNode[];
}

const INDEXED_LEVELS: readonly AdminLevel[] = [1, 2, 3, 4];

export function buildRegionIndex(snapshot: RegionSnapshot): RegionIndex {
  if (!snapshot.nodes.length) {
    throw new ParseKitError("E_SNAPSHOT_INVALID", "区域快照为空，拒绝初始化（不静默回退到任何内置数据源）");
  }
  const byCode = new Map<string, MutableNode>();
  for (const node of snapshot.nodes) {
    if (typeof node.code !== "string" || node.code.length === 0) {
      throw new ParseKitError("E_SNAPSHOT_INVALID", `区域快照存在非法代码: ${JSON.stringify(node)}`);
    }
    if (byCode.has(node.code)) {
      throw new ParseKitError("E_SNAPSHOT_INVALID", `区域快照代码重复: ${node.code}`);
    }
    byCode.set(node.code, {
      code: node.code,
      name: node.name,
      sourceName: node.sourceName ?? node.name,
      level: node.level,
      parentCode: node.parentCode,
      kind: node.kind,
      children: [],
    });
  }
  const roots: MutableNode[] = [];
  for (const node of byCode.values()) {
    if (node.level === 1) {
      if (node.parentCode !== null && byCode.has(node.parentCode)) {
        throw new ParseKitError("E_SNAPSHOT_INVALID", `一级节点不应有父级: ${node.code}`);
      }
      roots.push(node);
      continue;
    }
    if (node.parentCode === null) {
      throw new ParseKitError("E_SNAPSHOT_INVALID", `非一级节点缺少父级代码: ${node.code} (level ${node.level})`);
    }
    const parent = byCode.get(node.parentCode);
    if (!parent) {
      throw new ParseKitError("E_SNAPSHOT_INVALID", `节点父级不存在: ${node.code} -> ${node.parentCode}`);
    }
    if (parent.level >= node.level) {
      throw new ParseKitError("E_SNAPSHOT_INVALID", `父子层级非递增: ${parent.code}(L${parent.level}) -> ${node.code}(L${node.level})`);
    }
    parent.children.push(node);
  }

  const names = new Set<string>();
  const aliasMap = new Map<string, string[]>();
  for (const node of byCode.values()) {
    names.add(node.name);
    names.add(node.sourceName);
  }
  for (const node of snapshot.nodes) {
    const canonical = byCode.get(node.code);
    if (!canonical) continue;
    for (const alias of node.aliases ?? []) {
      names.add(alias);
      const list = aliasMap.get(canonical.name) ?? [];
      if (!list.includes(alias)) list.push(alias);
      aliasMap.set(canonical.name, list);
    }
  }

  const toTree = (node: MutableNode): DivisionTreeInput => {
    const children = node.children.filter((c) => INDEXED_LEVELS.includes(c.level)).map(toTree);
    return children.length ? { code: node.code, name: node.name, children } : { code: node.code, name: node.name };
  };
  const divisions = roots.filter((r) => r.children.length).map(toTree);
  if (!divisions.length) {
    throw new ParseKitError("E_SNAPSHOT_INVALID", "区域快照没有任何含子节点的省级数据，无法构建索引");
  }

  const readonlyByCode = new Map<string, { name: string; sourceName: string; level: AdminLevel; parentCode: string | null; kind: NodeKind }>();
  for (const [code, node] of byCode) {
    readonlyByCode.set(code, { name: node.name, sourceName: node.sourceName, level: node.level, parentCode: node.parentCode, kind: node.kind });
  }
  return {
    byCode: readonlyByCode,
    names,
    divisions,
    aliases: Object.fromEntries(aliasMap),
    datasetId: snapshot.datasetId,
    version: snapshot.version,
    codeScheme: snapshot.codeScheme,
  };
}
