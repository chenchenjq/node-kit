import { AreaKitError } from "../errors.js";
import type { ChildrenState, DatasetSummary, RegionSummary } from "../types.js";
import type { ChildFacts, ReadView, StoredRegion } from "./ports.js";

/** Normalize display text only; source fields remain unchanged for provenance. */
export function displayLabel(node: Pick<StoredRegion, "displayName" | "sourceName">): string {
  return (node.displayName ?? node.sourceName).trim();
}
export function effectiveEnabled(path: readonly StoredRegion[]): boolean {
  return path.length > 0 && path.every(node => node.enabled);
}
export function childrenState(facts: ChildFacts): ChildrenState {
  if (!facts.hasChildren) return "NONE_IN_SNAPSHOT";
  return facts.hasNavigableChildren ? "AVAILABLE" : "ALL_DISABLED";
}
export function summarizeDataset(row: DatasetSummary): DatasetSummary {
  return {datasetId: row.datasetId, versionCode: row.versionCode, source: row.source,
    sourceCommit: row.sourceCommit, rulesVersion: row.rulesVersion, codeScheme: row.codeScheme,
    dataAsOf: row.dataAsOf, sourcePublishedAt: row.sourcePublishedAt, coverage: row.coverage,
    levelCounts: row.levelCounts, status: row.status, isActive: row.isActive, importedAt: row.importedAt};
}
export async function summarizeNodes(view: ReadView, datasetId: string, rows: readonly StoredRegion[]): Promise<RegionSummary[]> {
  if (!rows.length) return [];
  const codes = rows.map(row => row.code);
  const paths = await view.getPaths(datasetId, codes);
  const facts = await view.getChildFacts(datasetId, codes);
  return rows.map(row => {
    const path = paths.get(row.code), childFacts = facts.get(row.code);
    if (!path?.length || path.at(-1)?.code !== row.code || !childFacts) throw new AreaKitError("QUERY_FAILED");
    const enabled = effectiveEnabled(path);
    return {code: row.code, sourceName: row.sourceName, label: displayLabel(row),
      level: row.level, parentCode: row.parentCode, nodeKind: row.nodeKind, enabled: row.enabled,
      effectiveEnabled: enabled, navigable: enabled, selectable: enabled && row.nodeKind !== "group",
      hasChildren: childFacts.hasChildren, childrenState: childrenState(childFacts), sort: row.sort, revision: row.revision};
  });
}
