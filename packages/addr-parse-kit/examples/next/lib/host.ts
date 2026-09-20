import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initParser, ParseKitError, type AddrParser, type AddressMeta, type RegionNode } from "addr-parse-kit/server";
import { createSnapshotProvider, readSnapshotFile, type SnapshotProvider } from "./provider";
import { asConfirmPayload, ProtocolError, selectionMatchesSnapshot, type ConfirmPayload, type SavedAddress } from "./protocol";

/**
 * 示例宿主的装配点：区域快照注入、解析器单例、认证/限流桩、确认结果暂存。
 * addr-parse-kit 只负责解析；认证、限流、输入校验、落库全部由这里（也就是宿主）负责。
 */

const DEFAULT_SNAPSHOT = fileURLToPath(new URL("../data/area-snapshot.demo.json", import.meta.url));

export class HostError extends Error {
  constructor(readonly status: 400 | 401 | 413 | 429 | 500 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "HostError";
  }
}

export interface Host {
  parser: AddrParser;
  provider: SnapshotProvider;
  nodes: ReadonlyMap<string, RegionNode>;
  /** 演示用内存暂存；生产宿主按 DATABASE.md 落库。 */
  saved: Map<string, SavedAddress>;
}

let hostPromise: Promise<Host> | null = null;

async function build(): Promise<Host> {
  const file = process.env.ADDR_PARSE_SNAPSHOT ?? DEFAULT_SNAPSHOT;
  const snapshot = await readSnapshotFile(file);
  const provider = createSnapshotProvider(snapshot);
  // 必须显式给出 datasetId/version；示例从注入的快照取，生产宿主应锁定在自己的配置里。
  const parser = await initParser({
    provider,
    datasetId: process.env.ADDR_PARSE_DATASET_ID ?? snapshot.datasetId,
    version: process.env.ADDR_PARSE_VERSION ?? snapshot.version,
  });
  return { parser, provider, nodes: new Map(snapshot.nodes.map((node) => [node.code, node])), saved: new Map() };
}

export function getHost(): Promise<Host> {
  hostPromise ??= build().catch((error: unknown) => {
    hostPromise = null;
    throw error;
  });
  return hostPromise;
}

export function errorToHostError(error: unknown): HostError {
  if (error instanceof HostError) return error;
  if (error instanceof ProtocolError) return new HostError(400, error.code, error.message);
  if (error instanceof ParseKitError) {
    if (error.code === "E_INPUT_TOO_LONG") return new HostError(413, error.code, error.message);
    if (error.code.startsWith("E_INPUT") || error.code.startsWith("E_BATCH") || error.code === "E_MAX_CANDIDATES") return new HostError(400, error.code, error.message);
    return new HostError(503, error.code, error.message);
  }
  return new HostError(500, "E_HOST", "服务端处理失败");
}

/**
 * 演示用认证桩：设置了 ADDR_PARSE_DEMO_SESSION 时要求请求带上匹配的会话 cookie。
 * 生产宿主必须换成自己的会话/JWT 校验，并按租户维度收紧限额。
 */
export async function authenticate(request: Request): Promise<string> {
  const required = process.env.ADDR_PARSE_DEMO_SESSION;
  if (required === undefined) return "anonymous";
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie.split(/;\s*/).find((part) => part.startsWith("addr_parse_session="))?.slice("addr_parse_session=".length);
  if (token === undefined || token !== required) throw new HostError(401, "E_UNAUTHORIZED", "缺少有效的会话凭证");
  return token;
}

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.ADDR_PARSE_DEMO_RATE_LIMIT ?? 120);
const hits = new Map<string, number[]>();

/** 演示用固定窗口限流。x-forwarded-for 只有可信反代才能采信，生产宿主按会话/租户计量。 */
export function rateLimit(bucket: string): void {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) throw new HostError(429, "E_RATE_LIMITED", "请求过于频繁，请稍后重试");
  recent.push(now);
  hits.set(bucket, recent);
  if (hits.size > 1000) for (const [key, times] of hits) if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(key);
}

/** 日志红线：只记录状态码、代码与长度，不记录收件原文、姓名和号码。 */
export function auditLine(input: { route: string; status: number; textLength?: number; recordId?: string }): string {
  return JSON.stringify(input);
}

/** 确认落库前的服务端复核：路径成立、代码与名称快照配对、警告只留痕不改写。 */
export async function confirmAddress(host: Host, value: unknown): Promise<{ record: SavedAddress; payload: ConfirmPayload }> {
  const hostMeta = host.parser.meta;
  const payload = asConfirmPayload(value, hostMeta, host.parser.limits.maxTextLength);
  const problems: string[] = [];
  for (const [slot, selection] of [["province", payload.province], ["city", payload.city], ["district", payload.district], ["street", payload.street], ["regionGroup", payload.regionGroup]] as const) {
    if (selection === null) continue;
    const mismatch = selectionMatchesSnapshot(selection, host.nodes.get(selection.code));
    if (mismatch) problems.push(`${slot}: ${mismatch}`);
  }
  const ordered = [payload.province, payload.regionGroup ?? payload.city, payload.district, payload.street]
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => s.code);
  const structural = host.parser.validateSelection(ordered);
  for (const problem of structural.problems) problems.push(`${problem.code}: ${problem.reason}`);
  const path = await host.provider.validatePath(ordered);
  for (const problem of path.problems) problems.push(`provider ${problem.code}: ${problem.reason}`);
  if (problems.length) throw new HostError(400, "E_REGION_SELECTION_INVALID", problems.join("；"));
  if (!payload.detailedAddress.trim() && payload.parseStatus !== "unmatched") throw new HostError(400, "E_DETAIL_EMPTY", "详细地址为空，需人工补全后再确认");

  const meta: AddressMeta = payload.meta;
  const record: SavedAddress = {
    id: randomUUID(),
    savedAt: new Date().toISOString(),
    recipientName: payload.recipient.name ?? null,
    phone: payload.recipient.phone ?? null,
    phoneExtension: payload.recipient.phoneExtension ?? null,
    provinceCode: payload.province?.code ?? null,
    cityCode: payload.city?.code ?? null,
    districtCode: payload.district?.code ?? null,
    streetCode: payload.street?.code ?? null,
    detailedAddress: payload.detailedAddress,
    view: payload.view,
    provinceName: payload.province?.name ?? null,
    cityName: payload.city?.name ?? null,
    districtName: payload.district?.name ?? null,
    streetName: payload.street?.name ?? null,
    parseStatus: payload.parseStatus,
    parseWarnings: payload.warnings,
    manualEdits: payload.manualEdits,
    regionSource: meta.regionSource,
    regionDatasetId: meta.datasetId,
    regionVersion: meta.regionVersion,
    codeScheme: meta.codeScheme,
    parserVersion: meta.parserVersion,
  };
  host.saved.set(record.id, record);
  return { record, payload };
}
