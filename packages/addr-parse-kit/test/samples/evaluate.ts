/**
 * 评测口径：字段识别 / 完整路径 / 歧义 / 关键内容保留。
 *
 * 准确率只与人工标注比对，**不使用引擎 confidence**，也不把「解析没报错」当成正确。
 * 报告只输出计数与用例编号，绝不输出地址原文、姓名或号码。
 */
import type { AddrParser } from "../../src/server/index.js";
import type { AddressCandidate, AdminLevel, LevelNode, ParseOptions, ParseStatus, ParseWarning, RegionNode, WarningCode } from "../../src/types.js";
import type { SyntheticCase } from "./synthetic/generate.js";

export interface AnnotatedCase {
  id: string;
  category: string;
  input: string;
  options?: ParseOptions;
  gold: { deepestCode: string | null; written?: SlotKey[] };
  expect: {
    status?: ParseStatus;
    requiresReview?: boolean;
    candidateCount?: number;
    recipient?: { name?: string; phone?: string; phoneExtension?: string; maskedPhone?: string; incompletePhone?: boolean; extraPhones?: string[] };
    recipientNull?: boolean;
    preserve?: string[];
    warnings?: WarningCode[];
    error?: string;
    /** 多候选场景下不存在唯一「正确路径」，只校验歧义处理，不计入路径指标。 */
    skipPath?: boolean;
  };
}

export interface GoldSlots {
  province: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  regionGroup: string | null;
}

const SLOT_OF_LEVEL: Partial<Record<AdminLevel, keyof GoldSlots>> = { 1: "province", 2: "city", 3: "district", 4: "street" };

const ALL_SLOTS: readonly SlotKey[] = ["province", "city", "district", "street"];
const SLOT_KEYS: readonly (keyof GoldSlots)[] = ["province", "city", "district", "street", "regionGroup"];

export type SlotKey = keyof GoldSlots;

/** 由「最深正确代码」反推标准槽位：group 节点不占行政槽，落到 regionGroup；未写出的层级默认被剥离。 */
export function goldSlots(nodes: readonly RegionNode[], deepestCode: string | null, written: readonly SlotKey[]): GoldSlots {
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const slots: GoldSlots = { province: null, city: null, district: null, street: null, regionGroup: null };
  let current = deepestCode === null ? undefined : byCode.get(deepestCode);
  while (current) {
    if (current.kind === "group") slots.regionGroup = current.code;
    else {
      const slot = SLOT_OF_LEVEL[current.level];
      if (slot && written.includes(slot)) slots[slot] = current.code;
    }
    current = current.parentCode === null ? undefined : byCode.get(current.parentCode);
  }
  return slots;
}

export function actualSlots(candidate: AddressCandidate): GoldSlots {
  // match === "none" 表示「疑似命中已退回详细地址」，不再算作路径槽位。
  const code = (node: AddressCandidate["province"]): string | null => (node && node.match !== "none" ? node.code : null);
  return {
    province: code(candidate.province),
    city: code(candidate.city),
    district: code(candidate.district),
    street: code(candidate.street),
    regionGroup: code(candidate.regionGroup),
  };
}

function levelNodes(candidate: AddressCandidate): LevelNode[] {
  return [candidate.province, candidate.city, candidate.district, candidate.street].filter((node): node is LevelNode => node !== null);
}

function keptText(candidate: AddressCandidate): string {
  const recipient = candidate.recipient;
  return [
    candidate.detailedAddress,
    candidate.residualText,
    recipient?.name,
    recipient?.phone,
    recipient?.maskedPhone,
    recipient?.phoneExtension,
    ...(recipient?.extraPhones ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function warningCodes(list: readonly ParseWarning[]): Set<string> {
  return new Set(list.map((warning) => warning.code));
}

function sameStringList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function checkRecipient(actual: AddressCandidate, expect: AnnotatedCase["expect"]): string[] {
  if (expect.recipientNull) return actual.recipient === null ? [] : ["期望不输出收件人，实际有值"];
  const want = expect.recipient;
  if (!want) return [];
  const got = actual.recipient;
  if (!got) return ["期望有收件人字段，实际为 null"];
  const failures: string[] = [];
  for (const key of ["name", "phone", "phoneExtension", "maskedPhone", "incompletePhone"] as const) {
    if (want[key] !== undefined && want[key] !== got[key]) failures.push(`${key} 与标注不一致`);
  }
  if (want.extraPhones !== undefined && !sameStringList(want.extraPhones, got.extraPhones)) failures.push("extraPhones 与标注不一致");
  return failures;
}

export interface MetricRow {
  metric: string;
  correct: number;
  total: number;
  ratio: number | null;
}

export interface SampleFailure {
  id: string;
  reason: string;
}

export interface EvalReport {
  set: string;
  count: number;
  metrics: MetricRow[];
  failures: SampleFailure[];
}

function toRows(counters: Map<string, { correct: number; total: number }>): MetricRow[] {
  return [...counters].map(([metric, row]) => ({ metric, ...row, ratio: row.total === 0 ? null : Number((row.correct / row.total).toFixed(4)) }));
}

export function evaluateAnnotated(parser: AddrParser, nodes: readonly RegionNode[], cases: readonly AnnotatedCase[]): EvalReport {
  const counters = new Map<string, { correct: number; total: number }>();
  const failures: SampleFailure[] = [];
  const bump = (metric: string, id: string, ok: boolean, reason: string) => {
    const row = counters.get(metric) ?? { correct: 0, total: 0 };
    row.total += 1;
    if (ok) row.correct += 1;
    else failures.push({ id, reason });
    counters.set(metric, row);
  };

  for (const testCase of cases) {
    let result;
    try {
      result = parser.parse(testCase.input, testCase.options);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
      bump("调用错误按预期抛出", testCase.id, testCase.expect.error === code, `意外抛出 ${code}`);
      continue;
    }
    if (testCase.expect.error) {
      bump("调用错误按预期抛出", testCase.id, false, `期望抛出 ${testCase.expect.error}，实际返回了结果`);
      continue;
    }
    const candidate = result.candidates[0];
    if (!candidate) {
      failures.push({ id: testCase.id, reason: "无候选返回" });
      continue;
    }
    if (testCase.expect.status !== undefined) {
      bump("状态判定", testCase.id, result.status === testCase.expect.status, `状态期望 ${testCase.expect.status}，实际 ${result.status}`);
    }
    if (testCase.expect.requiresReview !== undefined) {
      bump("复核标记", testCase.id, result.requiresReview === testCase.expect.requiresReview, `requiresReview 期望 ${String(testCase.expect.requiresReview)}，实际 ${String(result.requiresReview)}`);
    }
    if (testCase.expect.candidateCount !== undefined) {
      bump("候选条数", testCase.id, result.candidates.length === testCase.expect.candidateCount, `候选数期望 ${testCase.expect.candidateCount}，实际 ${result.candidates.length}`);
    }
    for (const code of testCase.expect.warnings ?? []) {
      const got = warningCodes(candidate.warnings);
      bump("警告码", testCase.id, got.has(code), `缺少警告 ${code}`);
    }
    if (!testCase.expect.skipPath) {
      const gold = goldSlots(nodes, testCase.gold.deepestCode, testCase.gold.written ?? ALL_SLOTS);
      const actual = actualSlots(candidate);
      let allRight = true;
      for (const key of SLOT_KEYS) {
        const ok = gold[key] === actual[key];
        if (!ok) allRight = false;
        bump(`字段识别:${key}`, testCase.id, ok, `${key} 期望 ${gold[key] ?? "null"}，实际 ${actual[key] ?? "null"}`);
      }
      bump("完整路径", testCase.id, allRight, "五个层级槽位未全部一致");
    }
    if (testCase.expect.recipient || testCase.expect.recipientNull) {
      const recipientFailures = checkRecipient(candidate, testCase.expect);
      bump("收件人字段", testCase.id, recipientFailures.length === 0, recipientFailures[0] ?? "");
    }
    for (const fragment of testCase.expect.preserve ?? []) {
      bump("关键内容保留", testCase.id, keptText(candidate).includes(fragment), `片段未保留（长度 ${fragment.length}）`);
    }
  }
  return { set: "annotated", count: cases.length, metrics: toRows(counters), failures };
}

/** 合成集只查结构性不变量，不查准确率。 */
export function checkSynthetic(parser: AddrParser, nodes: readonly RegionNode[], cases: readonly SyntheticCase[]): EvalReport {
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const counters = new Map<string, { correct: number; total: number }>();
  const failures: SampleFailure[] = [];
  const bump = (metric: string, id: string, ok: boolean, reason: string) => {
    const row = counters.get(metric) ?? { correct: 0, total: 0 };
    row.total += 1;
    if (ok) row.correct += 1;
    else failures.push({ id, reason });
    counters.set(metric, row);
  };

  for (const testCase of cases) {
    const result = parser.parse(testCase.input);
    const candidate = result.candidates[0]!;
    const kept = keptText(candidate);
    bump(
      "门牌要素保留",
      testCase.id,
      testCase.mustKeep.every((fragment) => kept.includes(fragment)),
      "楼栋/单元/房号片段未出现在 detail 或 residualText",
    );
    const codes = SLOT_KEYS.map((key) => actualSlots(candidate)[key]).filter((code): code is string => code !== null);
    bump("代码均来自宿主快照", testCase.id, codes.every((code) => byCode.has(code)), "出现了快照中不存在的区划代码");
    const explicit = levelNodes(candidate).filter((node) => node.match === "explicit");
    bump(
      "显式命中可在原文定位",
      testCase.id,
      explicit.every((node) => node.matchedRange !== undefined && node.matchedText !== undefined && testCase.input.includes(node.matchedText)),
      "显式层级缺少原文区间",
    );
    const inferred = levelNodes(candidate).filter((node) => node.match === "inferred");
    bump(
      "推断层级带警告",
      testCase.id,
      inferred.length === 0 || warningCodes(candidate.warnings).has("LEVELS_INFERRED"),
      "推断层级未标记 LEVELS_INFERRED",
    );
    bump("推断层级需复核", testCase.id, inferred.length === 0 || candidate.requiresReview, "含推断层级但未标记需复核");
    for (const node of inferred) {
      const source = byCode.get(node.code);
      bump(
        "未把原文缺失的层级当成命中",
        testCase.id,
        source === undefined || (!testCase.input.includes(source.name) && !testCase.input.includes(node.name)),
        "inferred 层级的名称其实出现在原文中（说明定位失败）",
      );
    }
  }
  return { set: "synthetic", count: cases.length, metrics: toRows(counters), failures };
}

export function formatReport(report: EvalReport): string {
  const lines = [`\n[${report.set}] 用例数 ${report.count}`];
  for (const row of report.metrics) {
    lines.push(`  ${row.metric.padEnd(28)} ${row.correct}/${row.total}${row.ratio === null ? "" : `  ${(row.ratio * 100).toFixed(2)}%`}`);
  }
  if (report.failures.length) {
    lines.push(`  失败明细（只含编号与期望值，不含原文）：`);
    for (const failure of report.failures) lines.push(`    ${failure.id}: ${failure.reason}`);
  }
  return lines.join("\n");
}
