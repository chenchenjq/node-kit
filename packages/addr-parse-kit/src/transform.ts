import type { AddressCandidate, LevelNode, OutputMode } from "./types.js";

export interface FormatOptions {
  mode?: OutputMode;
}

function clone(c: AddressCandidate): AddressCandidate {
  return structuredClone(c);
}

function foldText(street: LevelNode): string | null {
  if (street.match !== "explicit") return null;
  return street.matchedText ?? street.sourceName;
}

/** withStreet → withoutStreet：把原文中已识别的街道文本并回 detailedAddress 前部；幂等；不改原对象。 */
export function toWithoutStreet(c: AddressCandidate): AddressCandidate {
  const v = clone(c);
  if (v.mode === "withoutStreet") return v;
  v.mode = "withoutStreet";
  if (v.street) {
    const text = foldText(v.street);
    if (text !== null) {
      const original = v.detailedAddress;
      v.detailedAddress = original ? `${text} ${original}` : text;
      v.streetFolded = { text, restoredDetail: original, street: v.street };
    }
    v.street = null;
  }
  return v;
}

/** withoutStreet → withStreet：撤销并回，恢复街道槽位；幂等；不改原对象。 */
export function toWithStreet(c: AddressCandidate): AddressCandidate {
  const v = clone(c);
  if (v.mode === "withStreet") {
    delete v.streetFolded;
    return v;
  }
  v.mode = "withStreet";
  if (v.streetFolded) {
    v.detailedAddress = v.streetFolded.restoredDetail;
    v.street = v.streetFolded.street;
    delete v.streetFolded;
  }
  return v;
}

function segmentName(node: LevelNode | null): string | null {
  if (!node || node.match === "none") return null;
  return node.name;
}

/** 反向拼接纯地址文本：只使用明确字段，不对候选擅自取第一条；跳过 null，不虚构缺失层级。 */
export function formatAddress(c: AddressCandidate, options: FormatOptions = {}): string {
  const view = options.mode === "withoutStreet" ? toWithoutStreet(c) : options.mode === "withStreet" ? toWithStreet(c) : c;
  const segments = [segmentName(view.province), segmentName(view.city), segmentName(view.district), segmentName(view.street)];
  if (view.detailedAddress) segments.push(view.detailedAddress);
  const out: string[] = [];
  for (const s of segments) {
    if (!s) continue;
    const prev = out[out.length - 1];
    if (prev === s) continue;
    if (prev && s.length > 1 && prev.endsWith(s)) continue;
    if (prev && prev.length > 1 && s.startsWith(prev) && s !== prev) continue;
    out.push(s);
  }
  return out.join("");
}

/** 可选模板：收件人 + 电话 + 地址。掩码电话原样输出，不猜测数字。 */
export function formatRecipientLine(c: AddressCandidate, options: FormatOptions = {}): string {
  const parts: string[] = [];
  const r = c.recipient;
  if (r?.name) parts.push(r.name);
  if (r?.phone) parts.push(r.phoneExtension ? `${r.phone}转${r.phoneExtension}` : r.phone);
  else if (r?.maskedPhone) parts.push(r.maskedPhone);
  parts.push(formatAddress(c, options));
  return parts.join(" ");
}

export interface IntegrityIssue {
  field: string;
  reason: string;
}

/** 纯结构校验（不访问区域数据）；路径真实性由 server 的 validateSelection / provider.validatePath 负责。 */
export function validateAddressIntegrity(c: AddressCandidate): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const slots: [string, LevelNode | null, number][] = [
    ["province", c.province, 1],
    ["city", c.city, 2],
    ["district", c.district, 3],
    ["street", c.street, 4],
  ];
  for (const [field, node, level] of slots) {
    if (!node) continue;
    if (!node.code) issues.push({ field, reason: "节点缺少代码，未知层级应为 null 而不是空代码" });
    if (node.level !== level) issues.push({ field, reason: `槽位与真实层级不一致（节点 level=${node.level}）` });
    if (!node.name || !node.sourceName) issues.push({ field, reason: "名称/源名称缺失" });
  }
  if (c.mode === "withoutStreet" && c.street && !c.streetFolded) {
    issues.push({ field: "mode", reason: "withoutStreet 视图仍带有 street 槽位且无并回记录" });
  }
  if (c.streetFolded && c.streetFolded.text && !c.detailedAddress.startsWith(c.streetFolded.text) && c.mode === "withoutStreet") {
    issues.push({ field: "detailedAddress", reason: "街道并回标记与详细地址内容不一致，可能发生了二次拼接" });
  }
  if (/undefined/.test(c.detailedAddress)) issues.push({ field: "detailedAddress", reason: "详细地址中出现 undefined 字样" });
  return issues;
}
