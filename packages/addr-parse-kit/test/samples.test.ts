import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { initParser, type AddrParser } from "../src/server/index.js";
import { FIXTURE_NODES, FixtureProvider } from "./fixtures.js";
import { checkSynthetic, evaluateAnnotated, formatReport, type AnnotatedCase, type EvalReport } from "./samples/evaluate.js";
import { generateSyntheticCases } from "./samples/synthetic/generate.js";

const CASES_FILE = fileURLToPath(new URL("./samples/annotated/cases.json", import.meta.url));

interface CaseFile {
  dataset: string;
  cases: AnnotatedCase[];
}

const SYNTHETIC_COUNT = 500;

function fullRatio(report: EvalReport, metric: string): number {
  const row = report.metrics.find((item) => item.metric === metric);
  if (!row || row.total === 0) throw new Error(`评测缺少指标 ${metric}`);
  return row.correct / row.total;
}

let parser: AddrParser;
let annotated: CaseFile;
let syntheticReport: EvalReport;
let annotatedReport: EvalReport;

beforeAll(async () => {
  parser = await initParser({ provider: new FixtureProvider(), datasetId: "fixture-ds", version: "fixture-v1" });
  annotated = JSON.parse(readFileSync(CASES_FILE, "utf8")) as CaseFile;
  annotatedReport = evaluateAnnotated(parser, FIXTURE_NODES, annotated.cases);
  syntheticReport = checkSynthetic(parser, FIXTURE_NODES, generateSyntheticCases(FIXTURE_NODES, SYNTHETIC_COUNT));
  console.log(formatReport(annotatedReport));
  console.log(formatReport(syntheticReport));
});

describe("人工标注集：准确率口径", () => {
  it("标注集本身自洽（编号唯一、代码存在于快照）", () => {
    const ids = new Set(annotated.cases.map((item) => item.id));
    expect(ids.size).toBe(annotated.cases.length);
    const codes = new Set(FIXTURE_NODES.map((node) => node.code));
    for (const testCase of annotated.cases) {
      if (testCase.gold.deepestCode !== null) expect(codes.has(testCase.gold.deepestCode), `${testCase.id} 的标注代码不在快照里`).toBe(true);
    }
  });

  it("关键内容不得静默丢失（门牌/楼栋/单元/房号/社区/备注）", () => {
    expect(fullRatio(annotatedReport, "关键内容保留")).toBe(1);
  });

  it("歧义用例给出多候选且不预选，非歧义用例不产生多余候选", () => {
    const ambiguous = annotated.cases.filter((item) => item.expect.status === "ambiguous");
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const testCase of ambiguous) {
      const result = parser.parse(testCase.input, testCase.options);
      expect(result.candidates.length, `${testCase.id} 应给出多个候选`).toBeGreaterThan(1);
      expect(result.requiresReview, `${testCase.id} 歧义必须要求人工确认`).toBe(true);
      expect(result.candidates.length, `${testCase.id} 不得把候选压成一条`).toBeGreaterThan(1);
    }
    const single = annotated.cases.filter((item) => item.expect.candidateCount === 1);
    for (const testCase of single) {
      const result = parser.parse(testCase.input, testCase.options);
      expect(result.candidates.length, `${testCase.id} 出现多余候选`).toBe(1);
    }
  });

  it("调用错误按错误码抛出而不是伪装成 unmatched", () => {
    expect(fullRatio(annotatedReport, "调用错误按预期抛出")).toBe(1);
  });

  it("打印字段识别 / 完整路径 / 状态判定比例（不使用 confidence 作为准确率）", () => {
    const metrics = Object.fromEntries(annotatedReport.metrics.map((row) => [row.metric, `${row.correct}/${row.total}`]));
    expect(metrics["完整路径"]).toBeDefined();
    expect(metrics["字段识别:province"]).toBeDefined();
    expect(parser.parse(annotated.cases[0]!.input).candidates[0]!.confidence).toBeGreaterThan(0);
  });
});

describe("合成集：结构性不变量（不构成准确率结论）", () => {
  it("门牌要素保留 100%", () => {
    expect(fullRatio(syntheticReport, "门牌要素保留")).toBe(1);
  });

  it("输出的区划代码全部来自宿主快照", () => {
    expect(fullRatio(syntheticReport, "代码均来自宿主快照")).toBe(1);
  });

  it("显式命中都能回指原文区间", () => {
    expect(fullRatio(syntheticReport, "显式命中可在原文定位")).toBe(1);
  });

  it("推断层级一律带警告且要求复核", () => {
    expect(fullRatio(syntheticReport, "推断层级带警告")).toBe(1);
    expect(fullRatio(syntheticReport, "推断层级需复核")).toBe(1);
  });

  it("合成规模覆盖到位", () => {
    expect(syntheticReport.count).toBe(SYNTHETIC_COUNT);
  });
});
