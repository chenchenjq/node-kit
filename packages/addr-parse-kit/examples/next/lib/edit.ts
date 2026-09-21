import type { AddressCandidate, AdminLevel, LevelNode, Recipient } from "addr-parse-kit";
import { toWithStreet } from "addr-parse-kit";

/** 浏览器侧的手工修正工具：只改用户明确改动的字段，其余原样保留。 */

export type Slot = "province" | "city" | "district" | "street";

export const SLOTS: readonly Slot[] = ["province", "city", "district", "street"];

export const SLOT_LABEL: Record<Slot, string> = { province: "省", city: "市", district: "区县", street: "街道/乡镇" };

const SLOT_LEVEL: Record<Slot, 1 | 2 | 3 | 4> = { province: 1, city: 2, district: 3, street: 4 };

export interface RegionOption {
  code: string;
  name: string;
  level: number;
  kind: string;
}

export function slotNode(c: AddressCandidate, slot: Slot): LevelNode | null {
  return slot === "province" ? c.province : slot === "city" ? c.city : slot === "district" ? c.district : c.street;
}

/** 分组节点（直辖市“市辖区”、省直辖县级行政区划）与同级行政槽位互斥。 */
function groupAtLevel(c: AddressCandidate, level: AdminLevel): LevelNode | null {
  return c.regionGroup?.level === level ? c.regionGroup : null;
}

/** 下拉框的显示值：分组节点借用市级槽位显示。 */
export function selectionValue(c: AddressCandidate, slot: Slot): string {
  return slotNode(c, slot)?.code ?? groupAtLevel(c, SLOT_LEVEL[slot])?.code ?? "";
}

/** 该槽位下级的下钻起点代码。 */
export function anchorCode(c: AddressCandidate, slot: Slot): string | null {
  switch (slot) {
    case "province": return null;
    case "city": return c.province?.code ?? null;
    case "district": return c.city?.code ?? groupAtLevel(c, 2)?.code ?? null;
    case "street": return c.district?.code ?? null;
  }
}

/** 候选采纳后统一回到 withStreet 规范化形态，视图切换不回写结构。 */
export function normalized(c: AddressCandidate): AddressCandidate {
  return c.mode === "withStreet" ? c : toWithStreet(c);
}

/**
 * 修正某个槽位；更换区域后清空全部更深层级，避免“新名称 + 旧代码”残留。
 * option 为 null 表示清空该槽位及其下级。
 */
export function applyRegion(base: AddressCandidate, slot: Slot, option: RegionOption | null): AddressCandidate {
  const level = SLOT_LEVEL[slot];
  const next: AddressCandidate = structuredClone(normalized(base));
  const set = (target: Slot, node: LevelNode | null): void => {
    if (target === "province") next.province = node;
    else if (target === "city") next.city = node;
    else if (target === "district") next.district = node;
    else next.street = node;
  };
  for (const target of SLOTS) if (SLOT_LEVEL[target] > level) set(target, null);
  // 分组节点与同级行政槽位互斥，因此同级分组也一并作废。
  if (next.regionGroup !== null && next.regionGroup.level >= level) next.regionGroup = null;
  if (option === null) {
    set(slot, null);
    return touched(next);
  }

  const node: LevelNode = {
    code: option.code,
    name: option.name,
    sourceName: option.name,
    level: option.level as AdminLevel,
    match: "explicit",
    inferReason: "人工选择",
  };
  if (option.kind === "group") {
    if (slot !== "city") throw new Error(`示例数据只在市级槽位提供分组节点，${slot} 收到 kind=group`);
    set(slot, null);
    next.regionGroup = node;
  } else {
    if (option.level !== level) throw new Error(`区域 ${option.code} 的层级 ${option.level} 与槽位 ${slot}（要求 ${level}）不一致`);
    set(slot, node);
  }
  return touched(next);
}

function touched(next: AddressCandidate): AddressCandidate {
  next.deepestLevel = deepest(next);
  return next;
}

function deepest(c: AddressCandidate): 0 | 1 | 2 | 3 | 4 {
  for (const slot of [...SLOTS].reverse()) {
    const node = slotNode(c, slot);
    if (node && node.match !== "none") return SLOT_LEVEL[slot];
  }
  return 0;
}

export function applyDetail(base: AddressCandidate, detailedAddress: string): AddressCandidate {
  const next: AddressCandidate = structuredClone(normalized(base));
  next.detailedAddress = detailedAddress;
  return next;
}

export function applyRecipient(base: AddressCandidate, patch: Partial<Pick<Recipient, "name" | "phone" | "phoneExtension">>): AddressCandidate {
  const next: AddressCandidate = structuredClone(normalized(base));
  const recipient: Recipient = { ...(next.recipient ?? {}) };
  for (const key of ["name", "phone", "phoneExtension"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === "") delete recipient[key];
    else recipient[key] = value;
  }
  next.recipient = Object.keys(recipient).length ? recipient : null;
  return next;
}
