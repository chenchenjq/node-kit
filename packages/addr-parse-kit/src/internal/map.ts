import type { DivisionResult, ParseCandidateResult } from "address-smart-parse";
import type { RegionIndex } from "./snapshot.js";
import type {
  AddressCandidate,
  AdminLevel,
  LevelNode,
  ParseOptions,
  ParseStatus,
  ParseWarning,
  Recipient,
} from "../types.js";
import { findLabeledNames, findMaskedPhones, findPhones, findSpan, guessNameBefore, normalizeForCompare, precededByNoteLabel, stripSpans, extendWithLabel, type Span } from "./text.js";

const ENGINE_SLOTS: readonly (readonly ["province" | "city" | "county" | "street", AdminLevel])[] = [
  ["province", 1],
  ["city", 2],
  ["county", 3],
  ["street", 4],
];

const ROAD_SUFFIXES = new Set(["路", "巷", "弄", "坡", "道"]);

const PLACE_SUFFIX_RE = /(州|盟|旗|地区|自治县|自治州|特别行政区|行政区)$/;

/** 引擎偶尔把标签或噪声词当成姓名；这类词一律不写入 recipient.name，原文片段留在详细地址里。 */
const NON_NAME_WORDS = new Set([
  "身份证", "身份证号", "备注", "收件人", "联系人", "收货人", "姓名", "电话", "手机", "手机号", "联系电话", "联系方式",
  "地址", "详细地址", "邮编", "邮政编码", "邮箱", "快递", "驿站", "自提", "送货", "顺丰", "中通", "圆通", "申通", "韵达", "京东", "淘宝", "天猫",
]);

export interface MapContext {
  raw: string;
  index: RegionIndex;
  options: ParseOptions;
}

interface SlotNode {
  level: AdminLevel;
  node: LevelNode;
  span: Span | null;
}

function suspectRoadConsumption(raw: string, node: LevelNode, span: Span): boolean {
  const sourceName = node.sourceName || node.name;
  const mt = node.matchedText ?? "";
  if (!mt || mt === sourceName || !sourceName.startsWith(mt)) return false;
  let i = span.end;
  while (i < raw.length && /\s/.test(raw[i]!)) i++;
  const next = raw[i];
  if (!next) return false;
  if (ROAD_SUFFIXES.has(next)) {
    if (next === "道" && raw[i - 1] === "街") return false;
    return true;
  }
  if (next === "街" && raw[i + 1] !== "道") return true;
  return false;
}

function toLevelNode(node: DivisionResult, level: AdminLevel, sourceName: string): LevelNode {
  const base: LevelNode = { code: node.code, name: node.name, sourceName, level, match: node.matched ? "explicit" : "inferred" };
  if (node.matchedText) {
    base.matchedText = node.matchedText;
  }
  if (!node.matched) {
    base.inferReason = "引擎按唯一父子路径推断，未在原文中匹配到该层级文本";
  }
  return base;
}

function assignSpans(raw: string, slots: SlotNode[]): void {
  let strictFrom = 0;
  for (const slot of slots) {
    const mt = slot.node.matchedText;
    if (slot.node.match !== "explicit" || !mt) continue;
    let span = findSpan(raw, mt, strictFrom);
    if (!span) span = findSpan(raw, mt, 0);
    if (!span) continue;
    slot.span = span;
    slot.node.matchedRange = [span.start, span.end];
    strictFrom = span.end;
  }
}

export function collectSlots(cand: ParseCandidateResult, ctx: MapContext): { slots: SlotNode[]; regionGroup: LevelNode | null; stripped: LevelNode[]; suspects: SlotNode[]; unresolved: SlotNode[] } {
  const { raw, index, options } = ctx;
  const slots: SlotNode[] = [];
  const takenLevels = new Set<AdminLevel>();
  let regionGroup: LevelNode | null = null;
  const stripped: LevelNode[] = [];
  const suspects: SlotNode[] = [];
  const unresolved: SlotNode[] = [];
  for (const [slotKey, depthLevel] of ENGINE_SLOTS) {
    const node = cand[slotKey];
    if (!node) continue;
    const meta = index.byCode.get(node.code);
    if (!meta) {
      unresolved.push({ level: depthLevel, node: { code: node.code, name: node.name, sourceName: node.sourceName ?? node.name, level: depthLevel, match: "explicit" }, span: null });
      continue;
    }
    let levelNode = toLevelNode(node, meta.level, meta.sourceName);
    if (meta.kind === "group") {
      if (!regionGroup) {
        regionGroup = {
          code: node.code,
          name: meta.name,
          sourceName: meta.sourceName,
          level: meta.level,
          match: node.matched ? "explicit" : "inferred",
        };
      }
      continue;
    }
    if (takenLevels.has(meta.level)) {
      levelNode = { ...levelNode, match: "none" };
      unresolved.push({ level: meta.level, node: levelNode, span: null });
      continue;
    }
    takenLevels.add(meta.level);
    if (levelNode.match === "inferred") {
      if (!options.allowInferred) {
        stripped.push(levelNode);
        continue;
      }
      slots.push({ level: meta.level, node: levelNode, span: null });
      continue;
    }
    slots.push({ level: meta.level, node: levelNode, span: null });
  }
  assignSpans(raw, slots);
  for (const slot of [...slots]) {
    if (slot.node.match === "explicit" && slot.span && suspectRoadConsumption(raw, slot.node, slot.span)) {
      suspects.push(slot);
      slots.splice(slots.indexOf(slot), 1);
    } else if (slot.node.match === "explicit" && !slot.span) {
      unresolved.push(slot);
    }
  }
  slots.sort((a, b) => a.level - b.level);
  return { slots, regionGroup, stripped, suspects, unresolved };
}

function buildRecipient(cand: ParseCandidateResult, ctx: MapContext): { recipient: Recipient | null; spans: Span[]; warnings: ParseWarning[] } {
  const { raw } = ctx;
  const warnings: ParseWarning[] = [];
  const spans: Span[] = [];
  const recipient: Recipient = {};
  const phones = findPhones(raw);
  const enginePhone = cand.phone;
  let primaryPhone = enginePhone ? phones.find((p) => p.digits === enginePhone.replace(/\D+/g, "")) ?? null : null;
  if (enginePhone && !primaryPhone) {
    primaryPhone = phones[0] ?? null;
  }
  if (primaryPhone) {
    recipient.phone = primaryPhone.digits;
    if (primaryPhone.extension) recipient.phoneExtension = primaryPhone.extension;
    spans.push(primaryPhone.span);
    const others = phones.filter((p) => p !== primaryPhone);
    if (others.length) {
      recipient.extraPhones = others.map((p) => p.digits);
      spans.push(...others.map((p) => p.span));
      warnings.push({ code: "MULTIPLE_PHONES", message: "文本中存在多个电话号码，除主号码外均保留在 extraPhones，需人工确认" });
    }
  }
  const masked = findMaskedPhones(raw);
  if (masked.length) {
    recipient.maskedPhone = masked[0]!.text;
    recipient.incompletePhone = true;
    warnings.push({ code: "PHONE_MASKED", message: "检测到掩码电话，原样保留且未猜测缺失数字，电话信息不完整" });
  }
  const labeled = findLabeledNames(raw);
  const engineName = cand.name;
  const locatedEngine = engineName === undefined ? null : (labeled.find((l) => l.name === engineName)?.span ?? findSpan(raw, engineName, 0));
  const reasons: string[] = [];
  if (engineName !== undefined) {
    if (NON_NAME_WORDS.has(engineName)) reasons.push("是标签/噪声词");
    else if (ctx.index.names.has(engineName)) reasons.push("与区域名称重合");
    else if (PLACE_SUFFIX_RE.test(engineName)) reasons.push("以行政区后缀结尾");
    if (locatedEngine !== null && precededByNoteLabel(raw, locatedEngine.start)) reasons.push("位于备注/说明语句内");
  }
  if (engineName !== undefined && reasons.length > 0) {
    warnings.push({ code: "NAME_MAY_BE_PLACE", message: `引擎提取的姓名 "${engineName}" ${reasons.join("、")}，未采信为姓名，需人工确认` });
  }
  if (engineName !== undefined && reasons.length === 0 && locatedEngine !== null) {
    recipient.name = engineName;
    spans.push(locatedEngine);
  } else if (engineName !== undefined && reasons.length === 0) {
    recipient.name = engineName;
    warnings.push({ code: "TEXT_SPAN_UNRESOLVED", message: `姓名 "${engineName}" 未能在原文中定位` });
  } else if (labeled.length) {
    recipient.name = labeled[0]!.name;
    spans.push(labeled[0]!.span);
  } else if (primaryPhone) {
    const guess = guessNameBefore(raw, primaryPhone.span.start);
    if (guess && !precededByNoteLabel(raw, guess.start)) {
      recipient.name = guess.text;
      spans.push(guess);
      warnings.push({ code: "RECIPIENTS_AMBIGUOUS", message: `姓名 "${guess.text}" 由「电话前紧邻中文」启发式得出（原文无姓名标签），需人工确认` });
    }
  }
  const extraNames = labeled.filter((l) => l.name !== recipient.name).flatMap((l) => [l.name, ...l.extra]);
  if (extraNames.length) {
    recipient.extraNames = extraNames;
    warnings.push({ code: "RECIPIENTS_AMBIGUOUS", message: "文本中存在多个疑似姓名，除主姓名外保留在 extraNames，需人工确认" });
  }
  const hasAny = recipient.name || recipient.phone || recipient.maskedPhone || recipient.extraNames || recipient.extraPhones;
  return { recipient: hasAny ? recipient : null, spans: spans.map((s) => extendWithLabel(raw, s)), warnings };
}

function rebuildText(raw: string, slots: SlotNode[], entitySpans: Span[]): { detail: string; residual: string } {
  const adminSpans = slots.map((s) => s.span).filter((s): s is Span => s !== null);
  const tailStart = adminSpans.reduce((acc, s) => Math.max(acc, s.end), 0);
  if (!adminSpans.length) {
    return { detail: stripSpans(raw, entitySpans).trim(), residual: "" };
  }
  // entitySpans 是整段原文的绝对区间；裁剪 tail 时必须先平移 tailStart，否则会削掉错误位置的字符。
  const tail = raw.slice(tailStart);
  const tailSpans = entitySpans
    .filter((s) => s.start >= tailStart)
    .map((s) => ({ start: s.start - tailStart, end: s.end - tailStart, text: s.text }));
  const detail = stripSpans(tail, tailSpans).trim();
  const residual = stripSpans(raw.slice(0, tailStart), [...adminSpans, ...entitySpans.filter((s) => s.end <= tailStart)]).replace(/\s+/g, " ").trim();
  return { detail, residual };
}

function classify(slots: SlotNode[], candCount: number, sdkWarnings: string[], suspects: number, unresolved: number, allowInferredKept: boolean): ParseStatus {
  const explicit = slots.filter((s) => s.node.match === "explicit" && s.span);
  if (!explicit.length && !allowInferredKept) return "unmatched";
  if (candCount > 1 || sdkWarnings.includes("AMBIGUOUS_ADDRESS") || sdkWarnings.includes("CANDIDATES_TRUNCATED")) return "ambiguous";
  const deepest = Math.max(0, ...explicit.map((s) => s.level));
  if (deepest >= 3 && !suspects && !unresolved) return "matched";
  return "partial";
}

export function mapCandidate(cand: ParseCandidateResult, ctx: MapContext, siblingCount: number): AddressCandidate {
  const { raw, options } = ctx;
  const warnings: ParseWarning[] = [];
  const { slots, regionGroup, stripped, suspects, unresolved } = collectSlots(cand, ctx);
  const inferredKept = slots.filter((s) => s.node.match === "inferred");
  if (inferredKept.length) {
    warnings.push({ code: "LEVELS_INFERRED", message: `层级（${inferredKept.map((s) => s.node.name).join("、")}）由唯一父子路径推断，并非用户明确填写，必须人工确认` });
  }
  if (stripped.length) {
    warnings.push({ code: "LEVELS_STRIPPED", message: `引擎推断出的层级（${stripped.map((s) => s.name).join("、")}）已剥离；原文未明确提供，如需保留推断值请显式设置 allowInferred` });
  }
  for (const s of suspects) {
    warnings.push({ code: "STREET_MATCH_SUSPECT", message: `"${s.node.matchedText}" 后紧跟道路类字符，疑似道路名被误判为行政区（${s.node.sourceName}），已退回详细地址` });
  }
  for (const u of unresolved) {
    if (u.node.match === "explicit" && !u.span) {
      warnings.push({ code: "TEXT_SPAN_UNRESOLVED", message: `层级 ${u.node.name} 的命中片段未能在原文中唯一定位，详细结果是按整段原文重建的` });
    } else {
      warnings.push({ code: "PATH_MISMATCH", message: `候选中出现无法解释的层级节点：${u.node.name}(${u.node.code})` });
    }
  }
  if (cand.warnings.includes("CANDIDATES_TRUNCATED")) {
    warnings.push({ code: "CANDIDATES_TRUNCATED", message: "候选数量被上限截断，真实歧义可能更大，不得按当前结果直接确认" });
  }
  if (cand.warnings.includes("AMBIGUOUS_ADDRESS")) {
    warnings.push({ code: "AMBIGUOUS", message: "存在多个同等合理的行政路径候选，需要人工选择" });
  }
  let recipient: Recipient | null = null;
  let entitySpans: Span[] = [];
  if (options.extractRecipient !== false) {
    const built = buildRecipient(cand, ctx);
    recipient = built.recipient;
    entitySpans = built.spans;
    warnings.push(...built.warnings);
  } else if (cand.name || cand.phone) {
    warnings.push({ code: "RECIPIENT_SUPPRESSED", message: "已按要求关闭收件人信息出口；引擎仍从其内部 detail 中移除了实体文本，完整信息请查看原始输入 input" });
  }
  const rebuilt = rebuildText(raw, slots, entitySpans);
  if (cand.detail && rebuilt.detail) {
    const a = normalizeForCompare(cand.detail);
    const b = normalizeForCompare(rebuilt.detail);
    if (!a.includes(b) && !b.includes(a)) {
      warnings.push({ code: "ENGINE_DETAIL_MISMATCH", message: "引擎裁剪文本与本包重建文本不一致，已以基于原文区间重建的结果为准" });
    }
  }
  const byLevel = new Map<AdminLevel, LevelNode>();
  for (const s of slots) byLevel.set(s.level, s.node);
  for (const s of suspects) {
    const node: LevelNode = { ...s.node, match: "none" };
    delete node.matchedText;
    delete node.matchedRange;
    byLevel.set(s.level, node);
  }
  const deepestLevel = Math.max(0, ...slots.filter((s) => s.node.match === "explicit" && s.span).map((s) => s.level)) as 0 | 1 | 2 | 3 | 4;
  const status = classify(slots, siblingCount, cand.warnings, suspects.length, unresolved.length + stripped.filter((s) => s.level === 4).length, slots.some((s) => s.node.match === "inferred"));
  if (rebuilt.residual) {
    warnings.push({ code: "RESIDUAL_TEXT", message: "存在未归类文本（residualText），其中可能包含地址要素或交付备注，请人工确认" });
  }
  const requiresReview = status !== "matched" || warnings.length > 0 || inferredKept.length > 0;
  const result: AddressCandidate = {
    candidateId: cand.candidateId,
    rank: cand.rank,
    confidence: cand.confidence,
    scoreReasons: [...cand.scoreReasons],
    status,
    requiresReview,
    warnings,
    mode: "withStreet",
    province: byLevel.get(1) ?? null,
    city: byLevel.get(2) ?? null,
    district: byLevel.get(3) ?? null,
    street: byLevel.get(4) ?? null,
    regionGroup,
    deepestLevel,
    detailedAddress: rebuilt.detail,
    residualText: rebuilt.residual,
    recipient,
  };
  return result;
}
