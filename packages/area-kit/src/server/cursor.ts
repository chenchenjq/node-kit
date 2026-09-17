import { AreaKitError } from "../errors.js";
import type { NodeQuery, PageKey } from "./ports.js";

/** Fixed filter order and explicit defaults make semantically identical queries share cursors. */
export function normalizeQuery(query: NodeQuery): NodeQuery {
  const result: NodeQuery = {};
  if (query.parentCode !== undefined) result.parentCode = query.parentCode;
  if (query.level !== undefined) result.level = query.level;
  if (query.ancestorCode !== undefined) result.ancestorCode = query.ancestorCode;
  if (query.keyword !== undefined) result.keyword = query.keyword;
  result.selectableOnly = query.selectableOnly ?? false;
  return result;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join() === expected.sort().join();
}
export function encodeCursor(libraryKey: string, datasetId: string, query: NodeQuery, key: PageKey): string {
  return Buffer.from(JSON.stringify({v: 1, libraryKey, datasetId, query: normalizeQuery(query), key})).toString("base64url");
}
export function decodeCursor(cursor: string, libraryKey: string, datasetId: string, query: NodeQuery): PageKey {
  try {
    if (typeof cursor !== "string" || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(value) || !keys(value, ["v", "libraryKey", "datasetId", "query", "key"])
      || value.v !== 1 || value.libraryKey !== libraryKey || value.datasetId !== datasetId
      || !object(value.query) || !object(value.key)) throw new Error();
    const expected = normalizeQuery(query), actual = value.query;
    if (!keys(value.query, Object.keys(expected)) || Object.entries(expected).some(([key, field]) => actual[key] !== field)) throw new Error();
    const key = value.key;
    if (!keys(key, ["sort", "code"]) || typeof key.sort !== "number" || !Number.isInteger(key.sort)
      || key.sort < -2147483648 || key.sort > 2147483647 || typeof key.code !== "string" || key.code.length === 0) throw new Error();
    return {sort: key.sort, code: key.code};
  } catch { throw new AreaKitError("INVALID_ARGUMENT"); }
}
