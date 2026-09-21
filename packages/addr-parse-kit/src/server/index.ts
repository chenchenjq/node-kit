import { createParser, PARSER_VERSION } from "address-smart-parse";
import type { AddressParser } from "address-smart-parse";
import { ParseKitError } from "../errors.js";
import { buildRegionIndex, type RegionIndex } from "../internal/snapshot.js";
import { mapCandidate } from "../internal/map.js";
import { fallbackCandidate } from "../internal/fallback.js";
import type {
  AddressMeta,
  BatchItem,
  ParseLimits,
  ParseOptions,
  ParseResult,
  ParseWarning,
  PathCheck,
  PathProblem,
  RegionProvider,
  RegionSnapshot,
} from "../types.js";

export * from "../types.js";
export { ParseKitError } from "../errors.js";

const KIT_VERSION = "0.0.0";

export const DEFAULT_LIMITS: ParseLimits = {
  maxTextLength: 4096,
  maxBatchSize: 100,
  maxCandidatesDefault: 5,
  maxCandidatesHardCap: 20,
};

export interface InitParserOptions {
  provider: RegionProvider;
  datasetId: string;
  version: string;
  limits?: Partial<ParseLimits>;
}

interface CachedIndex {
  index: RegionIndex;
  parser: AddressParser;
}

const indexCache = new Map<string, CachedIndex>();

export interface AddrParser {
  readonly meta: AddressMeta;
  readonly limits: ParseLimits;
  parse(text: string, options?: ParseOptions): ParseResult;
  parseBatch(texts: readonly string[], options?: ParseOptions, recordIds?: readonly (string | undefined)[]): BatchItem[];
  validateSelection(codes: readonly (string | null | undefined)[]): PathCheck;
}

export async function initParser(opts: InitParserOptions): Promise<AddrParser> {
  const { provider, datasetId, version } = opts;
  if (!provider || typeof provider.loadSnapshot !== "function" || typeof provider.validatePath !== "function" || !provider.source) {
    throw new ParseKitError("E_REGION_INIT", "RegionProvider 不符合接口约定（需要 source/loadSnapshot/validatePath）");
  }
  if (!datasetId || !version) {
    throw new ParseKitError("E_REGION_INIT", "必须显式提供 datasetId 与 version，本包不支持跟随 active 的隐式版本");
  }
  const limits: ParseLimits = { ...DEFAULT_LIMITS, ...opts.limits };
  const key = `${provider.source}|${datasetId}|${version}`;
  let cached = indexCache.get(key);
  if (!cached) {
    let snapshot: RegionSnapshot;
    try {
      snapshot = await provider.loadSnapshot({ datasetId, version });
    } catch (cause) {
      throw new ParseKitError("E_REGION_INIT", `区域数据加载失败（${provider.source}/${datasetId}/${version}），不会静默回退到任何其他数据源: ${String(cause)}`);
    }
    if (snapshot.datasetId !== datasetId || snapshot.version !== version) {
      throw new ParseKitError("E_REGION_VERSION_MISMATCH", `Provider 返回快照版本 ${snapshot.datasetId}/${snapshot.version} 与请求 ${datasetId}/${version} 不一致`);
    }
    const index = buildRegionIndex(snapshot);
    try {
      const parser = createParser({ divisions: index.divisions, aliases: index.aliases, dataVersion: key });
      cached = { index, parser };
    } catch (cause) {
      throw new ParseKitError("E_REGION_INIT", `解析索引构建失败: ${String(cause)}`);
    }
    indexCache.set(key, cached);
  }
  const { index, parser } = cached;
  const meta: AddressMeta = {
    parserVersion: KIT_VERSION,
    sdkVersion: PARSER_VERSION,
    regionSource: provider.source,
    datasetId: index.datasetId,
    regionVersion: index.version,
    codeScheme: index.codeScheme,
  };

  function validateInput(text: string, options?: ParseOptions): void {
    if (typeof text !== "string") throw new ParseKitError("E_INPUT_TYPE", "输入必须是字符串");
    if (!text.trim()) throw new ParseKitError("E_INPUT_EMPTY", "输入为空白，视为调用错误而非未匹配");
    if (text.length > limits.maxTextLength) throw new ParseKitError("E_INPUT_TOO_LONG", `输入长度 ${text.length} 超过上限 ${limits.maxTextLength}`);
    const mc = options?.maxCandidates;
    if (mc !== undefined && (!Number.isInteger(mc) || mc < 1 || mc > limits.maxCandidatesHardCap)) {
      throw new ParseKitError("E_MAX_CANDIDATES", `maxCandidates 必须是 1..${limits.maxCandidatesHardCap} 的整数（本包不静默钳制取值）`);
    }
  }

  function parse(text: string, options: ParseOptions = {}): ParseResult {
    validateInput(text, options);
    const maxCandidates = options.maxCandidates ?? limits.maxCandidatesDefault;
    const engine = parser.parseAddress(text, { maxCandidates, extractIdCard: false, minConfidence: 0.05 });
    const ctx = { raw: text, index, options };
    let candidates = engine.map((c) => mapCandidate(c, ctx, engine.length));
    if (!candidates.length) {
      candidates = [fallbackCandidate(text, options.extractRecipient !== false)];
    }
    candidates = applyRegionHint(candidates, options.regionHint);
    const first = candidates[0]!;
    const warnings: ParseWarning[] = [...first.warnings];
    if (candidates.length > 1 && !warnings.some((w) => w.code === "AMBIGUOUS")) {
      warnings.push({ code: "AMBIGUOUS", message: `存在 ${candidates.length} 个候选路径，未预选任何一条；确认动作必须由宿主/用户完成` });
    }
    return {
      input: text,
      status: first.status,
      requiresReview: first.requiresReview || candidates.length > 1,
      warnings,
      candidates,
      meta,
    };
  }

  function parseBatch(texts: readonly string[], options: ParseOptions = {}, recordIds?: readonly (string | undefined)[]): BatchItem[] {
    if (!Array.isArray(texts)) throw new ParseKitError("E_BATCH_NOT_ARRAY", "批量输入必须是显式数组；多行字符串按一条记录处理");
    if (texts.length > limits.maxBatchSize) throw new ParseKitError("E_BATCH_TOO_LARGE", `批次大小 ${texts.length} 超过上限 ${limits.maxBatchSize}`);
    return texts.map((text, i) => {
      const item: BatchItem = { index: i, ok: false };
      if (recordIds?.[i] !== undefined) item.recordId = recordIds[i];
      try {
        item.result = parse(text, options);
        item.ok = true;
      } catch (err) {
        if (err instanceof ParseKitError) item.error = { code: err.code, message: err.message };
        else item.error = { code: "E_INPUT_TYPE", message: `第 ${i} 条解析失败: ${String(err)}` };
      }
      return item;
    });
  }

  function validateSelection(codes: readonly (string | null | undefined)[]): PathCheck {
    const problems: PathProblem[] = [];
    const filled = codes.map((c, i) => ({ c, i })).filter((x) => x.c != null && x.c !== "") as { c: string; i: number }[];
    let prevLevel = 0;
    for (const { c, i } of filled) {
      const metaNode = index.byCode.get(c);
      if (!metaNode) {
        problems.push({ code: c, reason: `代码不存在于区域快照 ${meta.datasetId}/${meta.regionVersion}` });
        continue;
      }
      if (metaNode.level <= prevLevel) problems.push({ code: c, reason: `层级 ${metaNode.level} 不高于前一级 ${prevLevel}，上下级关系失效` });
      prevLevel = metaNode.level;
      if (i > 0) {
        const ancestorOk = isAncestor(filled.slice(0, filled.findIndex((x) => x.c === c)).map((x) => x.c), c);
        if (!ancestorOk) problems.push({ code: c, reason: "与前面的选择不构成父子路径" });
      }
    }
    return { ok: problems.length === 0, problems };
  }

  function isAncestor(ancestors: readonly string[], code: string): boolean {
    let cur = index.byCode.get(code)?.parentCode ?? null;
    while (cur) {
      if (ancestors.includes(cur)) return true;
      cur = index.byCode.get(cur)?.parentCode ?? null;
    }
    return false;
  }

  return { meta, limits, parse, parseBatch, validateSelection };
}

function applyRegionHint(candidates: ReturnType<typeof mapCandidate>[], hint?: ParseOptions["regionHint"]): ReturnType<typeof mapCandidate>[] {
  if (!hint) return candidates;
  const hintCodes = [hint.provinceCode, hint.cityCode, hint.districtCode];
  const conflictsExplicit = (c: ReturnType<typeof mapCandidate>): boolean => {
    const nodes = [c.province, c.city, c.district];
    return nodes.some((node, i) => node && node.match === "explicit" && hintCodes[i] && node.code !== hintCodes[i]);
  };
  const kept = candidates.filter((c) => !conflictsExplicit(c));
  if (kept.length) return kept;
  return candidates.map((c, i) =>
    i === 0
      ? { ...c, warnings: [...c.warnings, { code: "HINT_CONFLICT" as const, message: "宿主区域提示与原文明示区域冲突，已保留原文匹配结果，未用提示覆盖" }] }
      : c,
  );
}
