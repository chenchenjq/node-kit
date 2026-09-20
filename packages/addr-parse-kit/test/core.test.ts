import { describe, expect, it } from "vitest";
import { initParser, type AddrParser } from "../src/server/index.js";
import { ParseKitError } from "../src/errors.js";
import { FixtureProvider, fixtureSnapshot } from "./fixtures.js";
import { formatAddress, formatRecipientLine, toWithStreet, toWithoutStreet, validateAddressIntegrity } from "../src/transform.js";
import type { ParseResult } from "../src/types.js";

async function makeParser(): Promise<{ parser: AddrParser; provider: FixtureProvider }> {
  const provider = new FixtureProvider();
  return { parser: await initParser({ provider, datasetId: "fixture-ds", version: "fixture-v1" }), provider };
}

const first = (r: ParseResult) => r.candidates[0]!;

describe("init 与区域源约束", () => {
  it("显式 datasetId/version 必填", async () => {
    const provider = new FixtureProvider();
    await expect(initParser({ provider, datasetId: "", version: "v" })).rejects.toThrow(ParseKitError);
  });

  it("Provider 加载失败必须显式报错，不回退内置数据", async () => {
    const provider = new FixtureProvider(undefined, new Error("db down"));
    await expect(initParser({ provider, datasetId: "fixture-ds", version: "fixture-v1" })).rejects.toMatchObject({ code: "E_REGION_INIT" });
  });

  it("快照版本与请求不一致时报版本冲突", async () => {
    const provider = new FixtureProvider(fixtureSnapshot({ version: "other" }));
    await expect(initParser({ provider, datasetId: "fixture-ds", version: "fixture-v1" })).rejects.toMatchObject({ code: "E_REGION_VERSION_MISMATCH" });
  });

  it("空快照拒绝初始化", async () => {
    const provider = new FixtureProvider(fixtureSnapshot({ nodes: [] }));
    await expect(initParser({ provider, datasetId: "fixture-ds", version: "fixture-v1" })).rejects.toMatchObject({ code: "E_SNAPSHOT_INVALID" });
  });

  it("同 datasetId+version 复用索引，不重复加载", async () => {
    const provider = new FixtureProvider();
    const a = await initParser({ provider, datasetId: "fixture-ds", version: "fixture-v1" });
    const b = await initParser({ provider, datasetId: "fixture-ds", version: "fixture-v1" });
    a.parse("广东省深圳市南山区粤海街道 1 栋");
    b.parse("广东省深圳市南山区粤海街道 1 栋");
    expect(provider.loadCount).toBe(1);
  });

  it("真实地址在注入源之外时不匹配（内置词典已被完全替换）", async () => {
    const { parser } = await makeParser();
    const r = parser.parse("四川省成都市武侯区桂溪街道天府三街 69 号");
    expect(r.status).toBe("unmatched");
    expect(first(r).province).toBeNull();
  });
});

describe("拆分与候选（对齐 spike 用例）", () => {
  it("A1 完整地址：各级 explicit，detail 保留原文样式", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("广东省深圳市南山区粤海街道科技园 CocoPark 3栋A座 1207室"));
    expect([c.province?.name, c.city?.name, c.district?.name, c.street?.name]).toEqual(["广东省", "深圳市", "南山区", "粤海街道"]);
    expect(c.district?.match).toBe("explicit");
    expect(c.detailedAddress).toContain("1207室");
    expect(c.detailedAddress).toContain("CocoPark");
    expect(c.status).toBe("matched");
    expect(c.requiresReview).toBe(false);
  });

  it("B1 输入止于区县：臆造乡镇被剥离，不冒充匹配", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("内蒙古通辽市科尔沁区 某路 15 号"));
    expect(c.street).toBeNull();
    expect(c.warnings.some((w) => w.code === "LEVELS_STRIPPED")).toBe(true);
    expect(c.deepestLevel).toBe(3);
    expect(c.detailedAddress).toBe("某路 15 号");
  });

  it("allowInferred 保留推断层级但强制复核", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("内蒙古通辽市科尔沁区 某路 15 号", { allowInferred: true }));
    expect(c.street?.match).toBe("inferred");
    expect(c.requiresReview).toBe(true);
  });

  it("A4 道路名含乡级前缀：降级回并详细地址并警示", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("贵州省毕节市大方县顺德路街道白阴村二组"));
    expect(c.street?.match ?? null).toBe("none");
    expect(c.detailedAddress).toContain("顺德路街道白阴村二组");
    expect(c.warnings.some((w) => w.code === "STREET_MATCH_SUSPECT")).toBe(true);
    expect(c.status).not.toBe("matched");
  });

  it("A9 重复地名不做全局去重", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("陕西省西安市西安市雁塔区小寨路街道 慈恩西路 2 号"));
    const kept = c.detailedAddress + c.residualText;
    expect(kept).toContain("西安市");
    expect(c.detailedAddress).toContain("慈恩西路 2 号");
  });

  it("直辖市分组节点不占城市槽位，拼接不出现「市辖区」", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("北京市朝阳区建外街道建国路 93 号 7 号楼 2 单元 1801"));
    expect(c.city).toBeNull();
    expect(c.regionGroup?.name).toBe("市辖区");
    expect(c.district?.name).toBe("朝阳区");
    expect(formatAddress(c)).toBe("北京市朝阳区建外街道建国路 93 号 7 号楼 2 单元 1801");
  });

  it("省直辖县级：分组进 regionGroup，区县落 district 槽", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("湖北省仙桃市干河街道仙居路 8 号"));
    expect(c.district?.name).toBe("仙桃市");
    expect(c.street?.name).toBe("干河街道");
    expect(c.regionGroup?.name).toBe("省直辖县级行政区划");
    expect(formatAddress(c)).toBe("湖北省仙桃市干河街道仙居路 8 号");
  });

  it("C4 重名区县：多候选 + 歧义，不默认确认第一条", async () => {
    const { parser } = await makeParser();
    const r = parser.parse("鼓楼区中山北路 1 号");
    expect(r.candidates.length).toBeGreaterThan(1);
    expect(r.status).toBe("ambiguous");
    expect(r.requiresReview).toBe(true);
    expect(new Set(r.candidates.map((c) => c.district?.code)).size).toBe(r.candidates.length);
  });

  it("maxCandidates=1 不把歧义变成唯一结果", async () => {
    const { parser } = await makeParser();
    const r = parser.parse("鼓楼区中山北路 1 号", { maxCandidates: 1 });
    expect(r.candidates.length).toBe(1);
    expect(r.status).toBe("ambiguous");
    expect(r.warnings.some((w) => w.code === "CANDIDATES_TRUNCATED")).toBe(true);
  });

  it("regionHint 与原文明示冲突时不覆盖原文", async () => {
    const { parser } = await makeParser();
    const r = parser.parse("陕西省西安市雁塔区小寨路街道 慈恩西路 2 号", { regionHint: { provinceCode: "32" } });
    expect(first(r).province?.code).toBe("61");
    expect(first(r).warnings.some((w) => w.code === "HINT_CONFLICT")).toBe(true);
  });
});

describe("收件信息", () => {
  it("A7 标签混排：姓名电话提取，地址不混入收件信息", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("收件人:王二小 手机:135-6789-0123 地址:浙江省宁波市鄞州区首南街道泰康中路 188 号 19 楼 备注:周末送货"));
    expect(c.recipient?.name).toBe("王二小");
    expect(c.recipient?.phone).toBe("13567890123");
    expect(c.detailedAddress).not.toContain("王二小");
    expect(c.detailedAddress).toContain("泰康中路 188 号 19 楼");
    expect(c.detailedAddress).toContain("备注:周末送货");
  });

  it("A12 多号码：第二条不丢失", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("联系人 陈一/陈二 13611112222 13633334444 广东省东莞市南城街道鸿福路 200 号"));
    expect(c.recipient?.extraPhones).toContain("13633334444");
    expect(c.recipient?.name).toBe("陈一");
    expect(formatRecipientLine(c)).toContain("13611112222");
  });

  it("A11 掩码电话：原样保留并标记不完整", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("赵女士 137****5566 北京市朝阳区建国路 93 号"));
    if (c.recipient?.maskedPhone) {
      expect(c.recipient.maskedPhone).toBe("137****5566");
      expect(c.recipient.incompletePhone).toBe(true);
    } else {
      expect(c.detailedAddress).toContain("137****5566");
    }
  });

  it("B4 州级地名不得作为姓名输出", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("云南省红河州蒙自市 天马路 99 号"));
    expect(c.recipient?.name).not.toBe("红河州");
    if (c.recipient?.name === undefined) expect(c.residualText + c.detailedAddress).toContain("红河州");
  });

  it("A5 长订单号数字不被吞或误判", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("订单号 8837261190458221 收件 李先生 13922223333 广东省广州市天河区天河路 228 号"));
    const all = c.detailedAddress + c.residualText;
    expect(all).toContain("8837261190458221");
  });

  it("extractRecipient=false 时不出口收件信息并给出提示", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("王二小 13512341234 浙江省宁波市鄞州区首南街道泰康中路 188 号", { extractRecipient: false }));
    expect(c.recipient).toBeNull();
    expect(c.warnings.some((w) => w.code === "RECIPIENT_SUPPRESSED")).toBe(true);
  });

  it("C1/C2 无区域候选时仍返回可信姓名电话与未匹配地址", async () => {
    const { parser } = await makeParser();
    const r = parser.parse("张三 13800138000 环湖东路 100 号 2 栋 301");
    expect(r.status).toBe("unmatched");
    const c = first(r);
    expect(c.recipient?.name).toBe("张三");
    expect(c.recipient?.phone).toBe("13800138000");
    expect(c.detailedAddress).toContain("环湖东路 100 号 2 栋 301");
    expect(c.requiresReview).toBe(true);
  });
});

describe("输出模式与反向拼接", () => {
  it("withStreet→withoutStreet 街道并回 detail，不丢村名级内容", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("广东省深圳市南山区粤海街道科技园 3 栋 1207 室"));
    const v = toWithoutStreet(c);
    expect(v.street).toBeNull();
    expect(v.detailedAddress).toContain("粤海街道");
    expect(v.detailedAddress).toContain("1207 室");
    expect(c.street?.name).toBe("粤海街道");
  });

  it("重复转换幂等，不多次追加街道", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("广东省深圳市南山区粤海街道科技园 3 栋"));
    const once = toWithoutStreet(c);
    const twice = toWithoutStreet(once);
    expect(twice.detailedAddress).toBe(once.detailedAddress);
    const back = toWithStreet(toWithStreet(once));
    expect(back.street?.name).toBe("粤海街道");
    expect(back.detailedAddress).toBe(c.detailedAddress);
  });

  it("withoutStreet 拼接不重复街道", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("广东省深圳市南山区粤海街道科技园 3 栋"));
    const text = formatAddress(toWithoutStreet(c), { mode: "withoutStreet" });
    expect(text.match(/粤海街道/g)?.length).toBe(1);
    expect(text).not.toMatch(/undefined|null/);
  });

  it("integrity 校验通过正常结果", async () => {
    const { parser } = await makeParser();
    const c = first(parser.parse("北京市朝阳区建外街道建国路 93 号"));
    expect(validateAddressIntegrity(c)).toEqual([]);
    expect(validateAddressIntegrity(toWithoutStreet(c))).toEqual([]);
  });
});

describe("调用错误与批量", () => {
  it("输入校验：非字符串/空白/超长", async () => {
    const { parser } = await makeParser();
    expect(() => parser.parse(123 as unknown as string)).toThrow(/E_INPUT_TYPE|输入/);
    expect(() => parser.parse("   \n ")).toThrow(ParseKitError);
    try {
      parser.parse(" " .repeat(4097));
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ParseKitError);
    }
  });

  it("maxCandidates 非法值直接报错而不是钳制", async () => {
    const { parser } = await makeParser();
    expect(() => parser.parse("广东省", { maxCandidates: 0 })).toThrow(/maxCandidates/);
    expect(() => parser.parse("广东省", { maxCandidates: 21 })).toThrow(/maxCandidates/);
  });

  it("批量：单条失败不丢整批，保留下标与 recordId，批内共用版本", async () => {
    const { parser } = await makeParser();
    const batch = parser.parseBatch(
      ["广东省深圳市南山区粤海街道 1 栋", "", "内蒙古通辽市科尔沁区 某路 15 号"],
      {},
      ["order-a", "order-b", "order-c"],
    );
    expect(batch[0]?.ok).toBe(true);
    expect(batch[1]?.ok).toBe(false);
    expect(batch[1]?.error?.code).toBe("E_INPUT_EMPTY");
    expect(batch[2]?.ok).toBe(true);
    expect(batch[1]?.recordId).toBe("order-b");
    expect(batch[0]?.result?.meta.regionVersion).toBe(batch[2]?.result?.meta.regionVersion);
  });

  it("批量大小超限报错", async () => {
    const { parser } = await makeParser();
    expect(() => parser.parseBatch(new Array(101).fill("广东省"))).toThrow(/上限/);
  });

  it("多行字符串按一条记录处理，不按换行拆分", async () => {
    const { parser } = await makeParser();
    const r = parser.parse("张三\n13800138000\n广东省深圳市南山区粤海街道干将东路 500 号\n南楼 409");
    expect(r.input.split("\n").length).toBe(4);
    expect(first(r).recipient?.phone).toBe("13800138000");
    expect(first(r).detailedAddress).toContain("南楼 409");
  });
});

describe("人工修正与路径校验", () => {
  it("validateSelection 拒绝失效路径", async () => {
    const { parser } = await makeParser();
    expect(parser.validateSelection(["44", "4403", "440305", "440305007"]).ok).toBe(true);
    const bad = parser.validateSelection(["44", "320106"]);
    expect(bad.ok).toBe(false);
    const missing = parser.validateSelection(["44", "4403", "999999"]);
    expect(missing.ok).toBe(false);
  });
});
