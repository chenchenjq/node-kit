import type { StoredRegion } from "../server/ports.js";

/** Compare full root-to-node source paths, excluding every local presentation field. */
export function sameSourceMeaning(a: readonly StoredRegion[], b: readonly StoredRegion[]): boolean {
  return a.length === b.length && a.every((node,index) => {
    const other = b[index];
    return other !== undefined && node.code === other.code && node.sourceName === other.sourceName &&
      node.level === other.level && node.parentCode === other.parentCode && node.nodeKind === other.nodeKind;
  });
}
