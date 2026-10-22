import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { fetchMcaDeliveryRegions, mapMcaDeliveryRegions } from "../src/source/mca-delivery-regions.js";

const node = (code: string, name: string, level: number, type: string, children: unknown[] = []) => ({ code, name, level, type, children });
const mainlandProvinceNames = [
  ["13", "河北省"], ["14", "山西省"], ["15", "内蒙古自治区"], ["21", "辽宁省"], ["22", "吉林省"],
  ["23", "黑龙江省"], ["32", "江苏省"], ["33", "浙江省"], ["34", "安徽省"], ["35", "福建省"],
  ["36", "江西省"], ["37", "山东省"], ["41", "河南省"], ["42", "湖北省"], ["43", "湖南省"],
  ["12", "天津市"], ["31", "上海市"], ["50", "重庆市"], ["44", "广东省"], ["45", "广西壮族自治区"], ["51", "四川省"], ["52", "贵州省"], ["53", "云南省"],
  ["54", "西藏自治区"], ["61", "陕西省"], ["62", "甘肃省"], ["63", "青海省"], ["64", "宁夏回族自治区"],
].map(([code, name]) => node(`${code}0000000000`, name!, 1, "省"));
const source = { status: 200, tag: null, data: {
  code: "00", name: null, level: 0, type: "", children: [
    node("110000000000", "北京市", 1, "直辖市", [
      node("110101000000", "东城区", 3, "市辖区"),
      node("110102000000", "西城区", 3, "市辖区"),
    ]),
    node("460000000000", "海南省", 1, "省", [
      node("469001000000", "五指山市", 3, "县级市"),
      node("469021000000", "定安县", 3, "县"),
    ]),
    node("650000000000", "新疆维吾尔自治区", 1, "自治区", [
      node("650100000000", "乌鲁木齐市", 2, "地级市", [
        node("650102000000", "天山区", 3, "市辖区"),
      ]),
      node("659013000000", "草湖市", 3, "县级市"),
    ]),
    ...mainlandProvinceNames,
    node("810000000000", "香港特别行政区", 1, "特别行政区"),
  ],
} };

describe("MCA GB/T 2260 shipping region mapping", () => {
  it("reproduces the pinned full MCA response and the OMS migration row count", async () => {
    const raw = await readFile(new URL("../snapshots/mca-xzqh-2026-09-23.json", import.meta.url), "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBe(271004);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    expect(sha256).toBe("a880ff2c2fc76f7e15c42dcef9476bd353fd48a2ce3ea397140358211636700e");
    const result = mapMcaDeliveryRegions(JSON.parse(raw) as unknown, {
      retrieved_at: "2026-09-24T00:00:00.000Z",
      http_date: "Wed, 23 Sep 2026 16:09:41 GMT",
      sha256,
      raw_response: raw,
    });
    expect(result.regions).toHaveLength(3217);
    expect(result.regions.filter(region => region.level === "PROVINCE")).toHaveLength(31);
    expect(result.regions.filter(region => region.node_kind === "GROUP")).toHaveLength(6);
    expect(result.regions).toContainEqual({ code: "653132", parent_code: "653100", name: "岑岭县", level: "COUNTY", node_kind: "COUNTY" });
    expect(result.regions).toContainEqual({ code: "659013", parent_code: "650000", name: "草湖市", level: "CITY", node_kind: "DIRECT_ADMIN" });
  });
  it("produces verifiable province, prefecture, county, and address-group nodes", () => {
    const result = mapMcaDeliveryRegions(source);
    expect(result).toEqual(expect.objectContaining({
      source: "https://dmfw.mca.gov.cn/9095/xzqh/getList?code=&maxLevel=3",
      country_region_code: "CN",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
    expect(result.regions).toEqual(expect.arrayContaining([
      { code: "110000", parent_code: null, name: "北京市", level: "PROVINCE", node_kind: "PROVINCE" },
      { code: "110100", parent_code: "110000", name: "北京市", level: "CITY", node_kind: "GROUP" },
      { code: "110101", parent_code: "110100", name: "东城区", level: "COUNTY", node_kind: "COUNTY" },
      { code: "650100", parent_code: "650000", name: "乌鲁木齐市", level: "CITY", node_kind: "PREFECTURE" },
      { code: "650102", parent_code: "650100", name: "天山区", level: "COUNTY", node_kind: "COUNTY" },
      { code: "659013", parent_code: "650000", name: "草湖市", level: "CITY", node_kind: "DIRECT_ADMIN" },
      { code: "469000", parent_code: "460000", name: "省直辖县级行政区划", level: "CITY", node_kind: "GROUP" },
      { code: "469001", parent_code: "460000", name: "五指山市", level: "CITY", node_kind: "DIRECT_ADMIN" },
      { code: "469021", parent_code: "469000", name: "定安县", level: "COUNTY", node_kind: "DIRECT_ADMIN" },
    ]));
    expect(result.regions.some(region => region.code === "810000")).toBe(false);
  });

  it("rejects duplicate codes, invalid GB codes, and invalid hierarchy instead of partially mapping", () => {
    expect(() => mapMcaDeliveryRegions({ ...source, data: { ...source.data, children: [...source.data.children, source.data.children[0]] } })).toThrow();
    expect(() => mapMcaDeliveryRegions({ ...source, data: { ...source.data, children: [node("110000000000", "北京市", 1, "直辖市", [node("110101000000", "东城区", 3, "市辖区"), node("110101000000", "东城区重复", 3, "市辖区")])] } })).toThrow();
    expect(() => mapMcaDeliveryRegions({ ...source, data: { ...source.data, children: [node("110000000000", "北京市", 1, "直辖市", [node("110101000000", "东城区", 2, "市辖区")])] } })).toThrow();
  });

  it("retains a source-provided address group without exposing it as a direct-admin region", () => {
    const hainan = node("460000000000", "海南省", 1, "省", [
      node("469001000000", "五指山市", 3, "县级市"),
      node("469000000000", "省直辖县级行政区划", 2, "省直辖县级行政区划", [
        node("469021000000", "定安县", 3, "县"),
      ]),
    ]);
    const fixture = {
      ...source,
      data: { ...source.data, children: source.data.children.map(value => value.code === "460000000000" ? hainan : value) },
    };
    const result = mapMcaDeliveryRegions(fixture);
    expect(result.regions.find(region => region.code === "469000")).toMatchObject({
      parent_code: "460000", name: "省直辖县级行政区划", level: "CITY", node_kind: "GROUP",
    });
    expect(result.regions.find(region => region.code === "469021")).toMatchObject({
      parent_code: "469000", level: "COUNTY", node_kind: "DIRECT_ADMIN",
    });
  });

  it("keeps county-level cities in a direct-admin group as city-level selectable regions", () => {
    const xinjiang = node("650000000000", "新疆维吾尔自治区", 1, "自治区", [
      node("659000000000", "自治区直辖县级行政区划", 2, "自治区直辖县级行政区划", [
        node("659013000000", "草湖市", 3, "县级市"),
        node("659001000000", "石河子市辖区", 3, "市辖区"),
      ]),
    ]);
    const fixture = { ...source, data: { ...source.data, children: source.data.children.map(value => value.code === "650000000000" ? xinjiang : value) } };
    const result = mapMcaDeliveryRegions(fixture);
    expect(result.regions.find(region => region.code === "659013")).toMatchObject({
      parent_code: "650000", level: "CITY", node_kind: "DIRECT_ADMIN",
    });
    expect(result.regions.find(region => region.code === "659001")).toMatchObject({
      parent_code: "659000", level: "COUNTY", node_kind: "DIRECT_ADMIN",
    });
  });

  it("rejects unsupported second-level node types", () => {
    const unsupported = node("130100000000", "未知管理区", 2, "未知管理区", [node("130101000000", "测试区", 3, "市辖区")]);
    const invalid = { ...source, data: { ...source.data, children: source.data.children.map(value => value.code === "130000000000"
      ? node("130000000000", "河北省", 1, "省", [unsupported]) : value) } };
    expect(() => mapMcaDeliveryRegions(invalid)).toThrow();
  });

  it("pins the exact official response bytes and publication HTTP date", async () => {
    const raw = `${JSON.stringify(source, null, 2)}\n`;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(raw, {
      status: 200,
      headers: { date: "Wed, 23 Sep 2026 16:09:41 GMT", "content-type": "application/json" },
    }));
    const snapshot = await fetchMcaDeliveryRegions(fetcher, () => new Date("2026-09-24T00:00:00.000Z"));
    expect(snapshot.source_response_date).toBe("2026-09-23T16:09:41.000Z");
    expect(snapshot.retrieved_at).toBe("2026-09-24T00:00:00.000Z");
    expect(snapshot.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(snapshot.raw_response).toBe(raw);
    expect(snapshot.version).toBe(`mca-xzqh:2026-09-23:${snapshot.sha256.slice(0, 16)}`);
  });
});
