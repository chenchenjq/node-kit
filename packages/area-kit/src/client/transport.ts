import type { ErrorCode } from "../types.js";

const errorCodes = new Set<ErrorCode>([
  "NOT_INITIALIZED", "UNKNOWN_CODE", "VERSION_UNAVAILABLE", "TARGET_LEVEL_NOT_REACHED", "PARENT_MISMATCH", "NOT_SELECTABLE",
  "FORBIDDEN", "QUERY_FAILED", "INVALID_ARGUMENT", "QUERY_LIMIT_EXCEEDED", "REVISION_CONFLICT", "IMPORT_CONFLICT", "INVALID_CONFIG",
]);

const messages: Record<ErrorCode, string> = {
  NOT_INITIALIZED: "区域库尚未初始化", UNKNOWN_CODE: "区域编码不存在", VERSION_UNAVAILABLE: "区域版本不可用",
  TARGET_LEVEL_NOT_REACHED: "未达到目标层级", PARENT_MISMATCH: "区域层级关系不匹配", NOT_SELECTABLE: "区域不可选择",
  FORBIDDEN: "无权执行此操作", QUERY_FAILED: "区域查询失败", INVALID_ARGUMENT: "请求参数无效",
  QUERY_LIMIT_EXCEEDED: "查询超过限制", REVISION_CONFLICT: "区域设置已被更新", IMPORT_CONFLICT: "区域数据导入冲突",
  INVALID_CONFIG: "区域库配置无效",
};

export class AreaClientError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(messages[code]);
    this.name = "AreaClientError";
    this.code = code;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decodes only the stable transport envelope; endpoint payload validation stays with the caller's types. */
export function decodeSuccess<T>(value: unknown): T {
  if (!record(value) || !Object.hasOwn(value, "data")) throw new AreaClientError("QUERY_FAILED");
  return value.data as T;
}

/** Never trust an arbitrary server message or an unrecognised error code in browser UI. */
export function decodeClientError(value: unknown): AreaClientError {
  if (!record(value) || !record(value.error) || typeof value.error.code !== "string" || !errorCodes.has(value.error.code as ErrorCode)) {
    return new AreaClientError("QUERY_FAILED");
  }
  return new AreaClientError(value.error.code as ErrorCode);
}
