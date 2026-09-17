import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { sourceFixture } from "./fixtures/source-fixture.js";
import { auditSource, readCanonicalRows, digestCanonicalRows } from "../src/source/audit.js";
import { sha256 } from "../src/source/prepare.js";
import { classifyNode } from "../src/source/kinds.js";
import { SOURCE_MANIFEST } from "../src/source/manifest.js";
import type { Level } from "../src/types.js";

async function audit(options = {}) {
  const fixture = await sourceFixture(options);
  const output = await mkdtemp(join(tmpdir(), "area-audit-test-"));
  return auditSource(fixture.directory, output, fixture.manifest);
}
async function modified(level: Level, contents: string | Buffer, checksum = true) {
  const fixture = await sourceFixture();
  const file = fixture.manifest.files[level - 1]!;
  await writeFile(join(fixture.directory, file.path), contents);
  if (checksum) { file.bytes = Buffer.byteLength(contents); file.sha256 = sha256(Buffer.from(contents)); }
  return auditSource(fixture.directory, await mkdtemp(join(tmpdir(), "area-audit-test-")), fixture.manifest);
}
async function rows(file: string) { const result = []; for await (const row of readCanonicalRows(file)) result.push(row); return result; }

it("reports a source conflict and never marks the audit passed", async () => {
  const result = await audit({ conflict: true });
  expect(result.report.passed).toBe(false);
  expect(result.report.counts[3].conflict).toBe(1);
  expect(result.report.counts[3].ancestorMismatch).toBe(1);
  expect((await rows(result.normalizedFiles[3])).map(row => row.code)).toEqual(["010102"]);
});
it("preserves same-name counties, raw names, leading zeroes and deterministic digests", async () => {
  const result = await audit();
  expect(result.report.passed).toBe(true);
  const stored = JSON.parse(await readFile(join(result.directory, "report.json"), "utf8"));
  expect(stored.issuesPath).toBe(result.report.issuesPath);
  const county = await rows(result.normalizedFiles[3]);
  expect(county.map(row => [row.code, row.sourceName, row.parentCode])).toEqual([["010101", "同名县", "0101"], ["010102", "同名县", "0101"]]);
  expect(county[0]?.ancestorCodes).toEqual(["01", "0101"]);
  expect(result.report.sourceDigests[3]).toBe(digestCanonicalRows(county));
  const raw = await modified(1, '\uFEFFcode,name\n01," 合成,省 "\n');
  expect((await rows(raw.normalizedFiles[1]))[0]?.sourceName).toBe(" 合成,省 ");
});
it("deduplicates exact records without failing", async () => {
  const result = await audit({ duplicate: true });
  expect(result.report.passed).toBe(true);
  expect(result.report.counts[3]).toMatchObject({ input: 3, duplicate: 1, valid: 2, conflict: 0 });
});
it("rejects missing parents and preserves whitespace code in issues", async () => {
  expect((await audit({ missingParent: true })).report.counts[3].missingParent).toBe(1);
  const result = await audit({ blankCode: true });
  expect(result.report.counts[3].invalid).toBe(1);
  expect(await readFile(result.report.issuesPath!, "utf8")).toContain(' 010101');
});
it.each([
  '', Buffer.from([0x63,0x6f,0x64,0x65,0x2c,0x6e,0x61,0x6d,0x65,0x0a,0xff]),
  'code,name\n01,"unclosed\n', 'code,name\n01,one,extra\n', 'code,code,name\n01,01,name\n', 'code\n01\n',
])("reports malformed UTF-8, CSV or headers", async contents => {
  const result = await modified(1, contents);
  expect(result.report.passed).toBe(false);
  expect(result.report.counts[1].invalid).toBeGreaterThan(0);
});
it("rejects wrong length, non-digits, empty code and whitespace-only names", async () => {
  const result = await modified(1, 'code,name\n1,short\nAA,letters\n,empty\n01,   \n');
  expect(result.report.counts[1].invalid).toBe(4);
  expect(result.report.counts[1].valid).toBe(0);
});
it("refuses bytes that do not match the manifest", async () => {
  const result = await modified(1, 'code,name\n01,changed\n', false);
  expect(result.report.passed).toBe(false);
  expect(result.report.counts[1].valid).toBe(0);
});
it("finds duplicates and conflicts across 10000-row chunks and caps samples", async () => {
  // The first conflicting tuple is record 1; its differing tuple is record 10003.
  // Identical 010101 tuples also straddle the 10000-record chunk boundary.
  const lines = ['code,name,cityCode,provinceCode', '010102,同名县,0101,01'];
  for (let index = 0; index < 10001; index++) lines.push('010101,同名县,0101,01');
  lines.push('010102,同名县,0101,02');
  for (let index = 0; index < 30; index++) lines.push(' ,invalid,0101,01');
  const result = await modified(3, lines.join('\n') + '\n');
  expect(result.report.passed).toBe(false);
  expect(result.report.counts[3]).toMatchObject({ duplicate: 10029, conflict: 1, valid: 1, invalid: 30, ancestorMismatch: 1 });
  expect((await rows(result.normalizedFiles[3])).map(row => row.code)).toEqual(['010101']);
  const issues = (await readFile(result.report.issuesPath!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(issues.filter(issue => issue.code === '010102' && issue.reason === 'conflict').map(issue => issue.raw.provinceCode)).toEqual(['01', '02']);
  const stored = JSON.parse(await readFile(join(result.directory, 'report.json'), 'utf8'));
  expect(stored.passed).toBe(false);
  expect(stored.counts[3].conflict).toBe(1);
  expect(stored.issuesPath).toBe(result.report.issuesPath);
  expect(result.report.samples.filter(sample => sample.level === 3)).toHaveLength(20);
});
it("classifies only exact fixed-source evidence and never guesses special names", () => {
  const row = { level: 2 as const, code: "1101", sourceName: "市辖区", parentCode: "11", ancestorCodes: ["11"] };
  expect(classifyNode(SOURCE_MANIFEST, row)).toBe("group");
  for (const changes of [{ code: "1102" }, { sourceName: "开发区" }, { parentCode: "12" }, { ancestorCodes: ["12"] }, { level: 3 as const }]) expect(classifyNode(SOURCE_MANIFEST, { ...row, ...changes })).toBe("unknown");
  expect(classifyNode({ ...SOURCE_MANIFEST, sourceCommit: "synthetic-test-only" }, row)).toBe("unknown");
});

it("checks every ancestor against the verified parent path", async () => {
  const result = await modified(5, 'code,name,streetCode,areaCode,cityCode,provinceCode\n010101001001,合成村,010101001,010102,0101,01\n');
  expect(result.report.counts[5]).toMatchObject({ ancestorMismatch: 1, missingParent: 0, valid: 0 });
  expect(await rows(result.normalizedFiles[5])).toEqual([]);
});
it("matches all nine documented group tuples and leaves synthetic special names unknown", async () => {
  const tuples = [["1101", "市辖区", "11"], ["1201", "市辖区", "12"], ["3101", "市辖区", "31"], ["5001", "市辖区", "50"], ["5002", "县", "50"], ["4190", "省直辖县级行政区划", "41"], ["4290", "省直辖县级行政区划", "42"], ["4690", "省直辖县级行政区划", "46"], ["6590", "自治区直辖县级行政区划", "65"]];
  for (const [code, sourceName, parentCode] of tuples) expect(classifyNode(SOURCE_MANIFEST, { code: code!, sourceName: sourceName!, parentCode: parentCode!, level: 2, ancestorCodes: [parentCode!] })).toBe("group");
  const result = await modified(1, 'code,name\n01,开发区\n');
  expect((await rows(result.normalizedFiles[1]))[0]?.nodeKind).toBe("unknown");
});

it("CLI check writes a failed fixed-manifest report with a nonzero exit and rejects manifest options", async () => {
  const fixture = await sourceFixture();
  const output = await mkdtemp(join(tmpdir(), "area-cli-check-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const execute = promisify(execFile);
  const checked = await execute(process.execPath, ["--import", "tsx", cli, "check", "--dir", fixture.directory, "--report-dir", output]).catch(error => error);
  expect(checked.code).toBe(1);
  expect(JSON.parse(checked.stdout).passed).toBe(false);
  const stored = JSON.parse(await readFile(join(output, "report.json"), "utf8"));
  expect(stored.manifest.sourceCommit).toBe(SOURCE_MANIFEST.sourceCommit);
  expect(stored.counts[1].valid).toBe(0);
  const rejected = await execute(process.execPath, ["--import", "tsx", cli, "check", "--dir", fixture.directory, "--report-dir", output, "--manifest", "synthetic"]).catch(error => error);
  expect(rejected.code).toBe(1);
  expect(JSON.parse(rejected.stderr).code).toBe("INVALID_ARGUMENT");
});
