import { describe, expect, it } from "vitest";
import { initParser, type AddrParser } from "../src/server/index.js";
import { applyDetail, applyRecipient, applyRegion, normalized, selectionValue, slotNode, type Slot } from "../examples/next/lib/edit.js";
import { createSnapshotProvider } from "../examples/next/lib/provider.js";
import { toWithoutStreet } from "../src/transform.js";
import { FixtureProvider, fixtureSnapshot } from "./fixtures.js";
import type { AddressCandidate, ParseResult } from "../src/types.js";

/** playground 的行为规则证据：不依赖浏览器，直接断言示例里的纯函数。 */

let parser: AddrParser;
async function engine(): Promise<AddrParser> {
  parser ??= await initParser({ provider: new FixtureProvider(), datasetId: "fixture-ds", version: "fixture-v1" });
  return parser;
}

async function candidate(text: string): Promise<AddressCandidate> {
  const result: ParseResult = (await engine()).parse(text);
  return result.candidates[0]!;
}

const OPTION = { code: "32", name: "江苏省", level: 1, kind: "region" } as const;

describe("换区域清下级", () => {
  it("改省级后清空市/区/街与分组", async () => {
    const base = await candidate("广东省深圳市南山区粤海街道 18 号");
    expect(base.street?.code).toBe("440305007");
    const next = applyRegion(base, "province", OPTION);
    expect(next.province?.code).toBe("32");
    expect([next.city, next.district, next.street, next.regionGroup]).toEqual([null, null, null, null]);
    expect(next.deepestLevel).toBe(1);
  });

  it("改区级只清空街道，保留上级", async () => {
    const base = await candidate("江苏省南京市鼓楼区中山北路 100 号");
    const next = applyRegion(base, "district", { code: "320106", name: "鼓楼区", level: 3, kind: "region" });
    expect(next.province?.code).toBe("32");
    expect(next.city?.code).toBe("3201");
    expect(next.district?.code).toBe("320106");
    expect(next.street).toBeNull();
  });

  it("跨区域的手工选择由宿主的父链校验拒绝", async () => {
    const base = await candidate("江苏省南京市鼓楼区中山北路 100 号");
    const mixed = applyRegion(base, "district", { code: "320302", name: "鼓楼区", level: 3, kind: "region" });
    const codes = [mixed.province, mixed.city, mixed.district].map((node) => node?.code ?? null);
    const provider = createSnapshotProvider(fixtureSnapshot());
    expect((await provider.validatePath(codes)).ok).toBe(false);
    expect((await provider.validatePath(["32", "3201", "320106"])).ok).toBe(true);
  });

  it("清空槽位连同下级，且不修改原候选", async () => {
    const base = await candidate("广东省深圳市南山区粤海街道 18 号");
    const next = applyRegion(base, "city", null);
    expect(next.city).toBeNull();
    expect(next.district).toBeNull();
    expect(next.street).toBeNull();
    expect(next.deepestLevel).toBe(1);
    expect(base.city?.code).toBe("4403");
    expect(base.district?.code).toBe("440305");
  });

  it("分组节点进 regionGroup，不冒充市级槽位", async () => {
    const base = await candidate("江苏省南京市鼓楼区中山北路 100 号");
    const withGroup = applyRegion(base, "city", { code: "1101", name: "市辖区", level: 2, kind: "group" });
    expect(withGroup.city).toBeNull();
    expect(withGroup.regionGroup?.code).toBe("1101");
    expect(withGroup.district).toBeNull();
    expect(selectionValue(withGroup, "city")).toBe("1101");
    const withRegion = applyRegion(base, "city", { code: "4403", name: "深圳市", level: 2, kind: "region" });
    expect(withRegion.city?.code).toBe("4403");
    expect(withRegion.regionGroup).toBeNull();
    expect(() => applyRegion(base, "district", { code: "1101", name: "市辖区", level: 2, kind: "group" })).toThrow(/市级槽位/);
  });

  it("层级与槽位不符直接抛错，不写混排结果", async () => {
    const base = await candidate("广东省深圳市南山区粤海街道 18 号");
    expect(() => applyRegion(base, "district", { code: "4403", name: "深圳市", level: 2, kind: "region" })).toThrow(/层级/);
  });

  it("人工选择的节点标为 explicit", async () => {
    const base = await candidate("广东省深圳市南山区粤海街道 18 号");
    const next = applyRegion(base, "province", OPTION);
    expect(next.province?.match).toBe("explicit");
    expect(next.province?.inferReason).toBe("人工选择");
  });
});

describe("模式与视图", () => {
  it("在 withoutStreet 候选上修正会先回到 withStreet", async () => {
    const folded = toWithoutStreet(await candidate("广东省深圳市南山区粤海街道 18 号"));
    expect(folded.mode).toBe("withoutStreet");
    const edited = applyDetail(folded, "科技园南路 20 号");
    expect(edited.mode).toBe("withStreet");
    expect(edited.street?.code).toBe("440305007");
    expect(edited.streetFolded).toBeUndefined();
    expect(edited.detailedAddress).toBe("科技园南路 20 号");
  });

  it("槽位读取返回对应层级节点", async () => {
    const base = await candidate("广东省深圳市南山区粤海街道 18 号");
    const levels: Record<Slot, 1 | 2 | 3 | 4> = { province: 1, city: 2, district: 3, street: 4 };
    for (const slot of ["province", "city", "district", "street"] as const) {
      expect(slotNode(base, slot)?.level).toBe(levels[slot]);
      expect(selectionValue(base, slot)).toBe(slotNode(base, slot)?.code);
    }
    expect(base.deepestLevel).toBe(4);
  });
});

describe("收件人修正", () => {
  it("空串删除字段，全空时 recipient 为 null", async () => {
    const base = await candidate("广东省深圳市南山区粤海街道 18 号 王小满 13800001111");
    expect(base.recipient?.name).toBe("王小满");
    const renamed = applyRecipient(base, { name: "李静" });
    expect(renamed.recipient).toEqual({ name: "李静", phone: "13800001111" });
    const cleared = applyRecipient(renamed, { name: "", phone: "" });
    expect(cleared.recipient).toBeNull();
    expect(base.recipient?.name).toBe("王小满");
  });

  it("normalized 只作用于结构，不吞掉详细地址", async () => {
    const base = await candidate("广东省深圳市南山区粤海街道 18 号 3 栋 1205");
    expect(normalized(base)).toBe(base);
    expect(applyDetail(base, "").detailedAddress).toBe("");
  });
});
