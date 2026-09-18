import type { NodeKind } from "../types.js";
import type { CanonicalRow } from "./audit.js";
import { SOURCE_COMMIT, SOURCE_MANIFEST } from "./manifest.js";
import type { SourceManifest } from "./manifest.js";

/** PRD 003-area-kit §source: fixed dist/cities.csv tuples and their provinceCode relationships.
 * No region/statisticalUnit assertion is supported by this source's construction evidence.
 */
export const CLASSIFICATION_EVIDENCE = [
  ["1101", "市辖区", "11"], ["1201", "市辖区", "12"], ["3101", "市辖区", "31"],
  ["5001", "市辖区", "50"], ["5002", "县", "50"],
  ["4190", "省直辖县级行政区划", "41"], ["4290", "省直辖县级行政区划", "42"],
  ["4690", "省直辖县级行政区划", "46"], ["6590", "自治区直辖县级行政区划", "65"],
].map(([code, sourceName, parentCode]) => ({
  sourceCommit: SOURCE_COMMIT, code: code!, sourceName: sourceName!, parentCode: parentCode!, level: 2 as const,
  evidence: `https://github.com/modood/Administrative-divisions-of-China/blob/${SOURCE_COMMIT}/dist/cities.csv`,
  relationship: { provinceCode: parentCode! }, nodeKind: "group" as const,
}));

export function classifyNode(manifest: SourceManifest, row: Omit<CanonicalRow, "nodeKind">): NodeKind {
  if (manifest.source !== SOURCE_MANIFEST.source || manifest.sourceCommit !== SOURCE_COMMIT) return "unknown";
  const match = CLASSIFICATION_EVIDENCE.find(entry => entry.level === row.level && entry.code === row.code &&
    entry.sourceName === row.sourceName && entry.parentCode === row.parentCode &&
    row.ancestorCodes.length === 1 && row.ancestorCodes[0] === entry.parentCode);
  return match?.nodeKind ?? "unknown";
}
