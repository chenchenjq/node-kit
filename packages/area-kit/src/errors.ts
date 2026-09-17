import type { ErrorCode } from "./types.js";

const errorMessages: Record<ErrorCode, string> = {
  NOT_INITIALIZED: "区域库尚未初始化",
  UNKNOWN_CODE: "区域编码不存在",
  VERSION_UNAVAILABLE: "区域版本不可用",
  TARGET_LEVEL_NOT_REACHED: "未达到目标层级",
  PARENT_MISMATCH: "区域层级关系不匹配",
  NOT_SELECTABLE: "区域不可选择",
  FORBIDDEN: "无权执行此操作",
  QUERY_FAILED: "区域查询失败",
  INVALID_ARGUMENT: "请求参数无效",
  QUERY_LIMIT_EXCEEDED: "查询超过限制",
  REVISION_CONFLICT: "区域设置已被更新",
  IMPORT_CONFLICT: "区域数据导入冲突",
  INVALID_CONFIG: "区域库配置无效",
};

// Next instrumentation and route chunks can contain separate copies of this module.
// A shared symbol recognizes library-created errors without trusting a code/name lookalike.
const areaErrorBrand = Symbol.for("area-kit.AreaKitError");

export class AreaKitError extends Error {
  readonly [areaErrorBrand] = true;
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(errorMessages[code]);
    this.name = "AreaKitError";
    this.code = code;
  }

  toJSON(): { code: ErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function sanitizeError(error: unknown): AreaKitError {
  if (error instanceof AreaKitError) return error;
  if (error instanceof Error && Object.getOwnPropertyDescriptor(error, areaErrorBrand)?.value === true) {
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (typeof code === "string" && Object.hasOwn(errorMessages, code) &&
        "toJSON" in error && typeof error.toJSON === "function") return error as AreaKitError;
  }
  return new AreaKitError("QUERY_FAILED");
}
