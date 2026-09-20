import type { AddressMeta, OutputMode, ParseStatus, RegionNode, WarningCode } from "addr-parse-kit";

/** 浏览器侧与服务侧共用的确认协议：纯类型 + 纯校验，不接触 Node API。 */

export interface RegionSelection {
  code: string;
  name: string;
  level: number;
}

export interface RecipientInput {
  name?: string;
  phone?: string;
  phoneExtension?: string;
}

/** 浏览器提交的区域身份；包版本由服务端解析器补齐，不接受浏览器写入。 */
export interface RegionIdentity {
  regionSource: string;
  datasetId: string;
  regionVersion: string;
  codeScheme: string;
}

export type ConfirmRequest = Omit<ConfirmPayload, "meta"> & { meta: RegionIdentity };

export interface ConfirmPayload {
  candidateId: string;
  /** 宿主展示视图偏好；提交与落库的地址结构永远是规范化 withStreet 形态。 */
  view: OutputMode;
  parseStatus: ParseStatus;
  requiresReview: boolean;
  manualEdits: boolean;
  province: RegionSelection | null;
  city: RegionSelection | null;
  district: RegionSelection | null;
  street: RegionSelection | null;
  regionGroup: RegionSelection | null;
  detailedAddress: string;
  recipient: RecipientInput;
  warnings: WarningCode[];
  meta: AddressMeta;
}

export interface SavedAddress {
  id: string;
  savedAt: string;
  /** 用户确认结果：只有确认过的路径与详细地址才是业务事实。 */
  recipientName: string | null;
  phone: string | null;
  phoneExtension: string | null;
  provinceCode: string | null;
  cityCode: string | null;
  districtCode: string | null;
  streetCode: string | null;
  detailedAddress: string;
  /** 展示视图偏好；代码与详细地址按规范化 withStreet 结构存储，withoutStreet 由视图派生。 */
  view: OutputMode;
  /** 名称快照：区域数据后续更新不回写历史行。 */
  provinceName: string | null;
  cityName: string | null;
  districtName: string | null;
  streetName: string | null;
  /** 解析建议留痕：不参与配送，只用于复盘。 */
  parseStatus: ParseStatus;
  parseWarnings: WarningCode[];
  manualEdits: boolean;
  regionSource: string;
  regionDatasetId: string;
  regionVersion: string;
  codeScheme: string;
  parserVersion: string;
}

export class ProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function fail(reason: string): never {
  throw new ProtocolError("E_HOST_INPUT", reason);
}

export function asObject(value: unknown, at = "body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${at} 必须是 JSON 对象`);
  return value as Record<string, unknown>;
}

export function asKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${at} 含未知字段 ${key}`);
}

export function asString(value: unknown, at: string, maxLength: number): string {
  if (typeof value !== "string") fail(`${at} 必须是字符串`);
  if (value.length > maxLength) fail(`${at} 超过长度上限 ${maxLength}`);
  return value;
}

export function asBoolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") fail(`${at} 必须是布尔值`);
  return value;
}

export function asOptionalString(value: unknown, at: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = asString(value, at, maxLength);
  return text.length ? text : undefined;
}

const WARNING_CODES: readonly WarningCode[] = [
  "AMBIGUOUS", "CANDIDATES_TRUNCATED", "LOW_CONFIDENCE", "LEVELS_INFERRED", "LEVELS_STRIPPED", "STREET_MATCH_SUSPECT",
  "NAME_MAY_BE_PLACE", "RECIPIENTS_AMBIGUOUS", "PHONE_MASKED", "MULTIPLE_PHONES", "TEXT_SPAN_UNRESOLVED",
  "ENGINE_DETAIL_MISMATCH", "HINT_CONFLICT", "COVERAGE_UNKNOWN", "RESIDUAL_TEXT", "RECIPIENT_SUPPRESSED",
  "EXTRACT_FAILED", "PATH_MISMATCH",
];

const STATUSES: readonly ParseStatus[] = ["matched", "ambiguous", "partial", "unmatched"];

function asWarningCodes(value: unknown, at: string): WarningCode[] {
  if (!Array.isArray(value) || value.length > 32) fail(`${at} 必须是长度 ≤32 的数组`);
  return value.map((item) => {
    if (typeof item !== "string" || !WARNING_CODES.includes(item as WarningCode)) fail(`${at} 含未知警告码`);
    return item as WarningCode;
  });
}

/** 只接受字符串字段，掩码电话原样保留，服务端不改写号码数字。 */
export function asRecipient(value: unknown, at: string): RecipientInput {
  const record = asObject(value, at);
  asKeys(record, ["name", "phone", "phoneExtension"], at);
  const recipient: RecipientInput = {};
  const name = asOptionalString(record.name, `${at}.name`, 40);
  const phone = asOptionalString(record.phone, `${at}.phone`, 24);
  const extension = asOptionalString(record.phoneExtension, `${at}.phoneExtension`, 12);
  if (name !== undefined) recipient.name = name;
  if (phone !== undefined) recipient.phone = phone;
  if (extension !== undefined) recipient.phoneExtension = extension;
  return recipient;
}

function asSelection(value: unknown, at: string): RegionSelection | null {
  if (value === null) return null;
  const record = asObject(value, at);
  asKeys(record, ["code", "name", "level"], at);
  const level = record.level;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 5) fail(`${at}.level 非法`);
  return {
    code: asString(record.code, `${at}.code`, 24),
    name: asString(record.name, `${at}.name`, 64),
    level,
  };
}

function asMeta(value: unknown, at: string, host: AddressMeta): AddressMeta {
  const record = asObject(value, at);
  asKeys(record, ["regionSource", "datasetId", "regionVersion", "codeScheme"], at);
  const meta: AddressMeta = {
    parserVersion: host.parserVersion,
    sdkVersion: host.sdkVersion,
    regionSource: asString(record.regionSource, `${at}.regionSource`, 64),
    datasetId: asString(record.datasetId, `${at}.datasetId`, 64),
    regionVersion: asString(record.regionVersion, `${at}.regionVersion`, 64),
    codeScheme: asString(record.codeScheme, `${at}.codeScheme`, 64),
  };
  // 版本以服务端解析器为准；浏览器提交的版本只用于发现前后端不一致。
  for (const key of ["regionSource", "datasetId", "regionVersion", "codeScheme"] as const) {
    if (meta[key] !== host[key]) fail(`${at}.${key} 与服务端解析器不一致（${meta[key]} != ${host[key]}）`);
  }
  return meta;
}

export function asConfirmPayload(value: unknown, hostMeta: AddressMeta, maxDetailLength: number): ConfirmPayload {
  const record = asObject(value);
  asKeys(record, [
    "candidateId", "view", "parseStatus", "requiresReview", "manualEdits",
    "province", "city", "district", "street", "regionGroup", "detailedAddress", "recipient", "warnings", "meta",
  ], "body");
  if (record.view !== "withStreet" && record.view !== "withoutStreet") fail("body.view 非法");
  if (typeof record.parseStatus !== "string" || !STATUSES.includes(record.parseStatus as ParseStatus)) fail("body.parseStatus 非法");
  const detail = asString(record.detailedAddress, "body.detailedAddress", maxDetailLength);
  return {
    candidateId: asString(record.candidateId, "body.candidateId", 64),
    view: record.view,
    parseStatus: record.parseStatus as ParseStatus,
    requiresReview: asBoolean(record.requiresReview, "body.requiresReview"),
    manualEdits: asBoolean(record.manualEdits, "body.manualEdits"),
    province: asSelection(record.province, "body.province"),
    city: asSelection(record.city, "body.city"),
    district: asSelection(record.district, "body.district"),
    street: asSelection(record.street, "body.street"),
    regionGroup: asSelection(record.regionGroup, "body.regionGroup"),
    detailedAddress: detail,
    recipient: asRecipient(record.recipient, "body.recipient"),
    warnings: asWarningCodes(record.warnings, "body.warnings"),
    meta: asMeta(record.meta, "body.meta", hostMeta),
  };
}

/** 服务端用区域快照复核名称与代码是否配对，避免“新名称 + 旧代码”这类混排结果落库。 */
export function selectionMatchesSnapshot(selection: RegionSelection | null, node: RegionNode | undefined): string | null {
  if (selection === null) return null;
  if (!node) return `${selection.code} 不在当前区域快照中`;
  if (node.level !== selection.level) return `${selection.code} 的层级为 ${node.level}，与提交值 ${selection.level} 不一致`;
  if (node.name !== selection.name && node.sourceName !== selection.name) return `${selection.code} 的名称快照与当前区域数据不一致`;
  return null;
}
