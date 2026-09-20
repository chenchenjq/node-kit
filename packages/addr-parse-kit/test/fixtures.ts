import type { AdminLevel, PathCheck, RegionNode, RegionProvider, RegionSnapshot } from "../src/types.js";

const n = (code: string, name: string, level: 1 | 2 | 3 | 4 | 5, parentCode: string | null, kind: RegionNode["kind"] = "region", aliases?: readonly string[]): RegionNode =>
  aliases ? { code, name, level, parentCode, kind, aliases } : { code, name, level, parentCode, kind };

export const FIXTURE_NODES: RegionNode[] = [
  n("11", "北京市", 1, null),
  n("1101", "市辖区", 2, "11", "group"),
  n("110105", "朝阳区", 3, "1101"),
  n("110105001", "建外街道", 4, "110105"),

  n("31", "上海市", 1, null),
  n("3101", "市辖区", 2, "31", "group"),
  n("310115", "浦东新区", 3, "3101"),
  n("310115125", "张江镇", 4, "310115"),

  n("44", "广东省", 1, null),
  n("4403", "深圳市", 2, "44"),
  n("440305", "南山区", 3, "4403"),
  n("440305007", "粤海街道", 4, "440305"),
  n("440305007001", "科技园社区", 5, "440305007", "statisticalUnit"),
  n("4419", "东莞市", 2, "44"),
  n("441900", "东莞市", 3, "4419"),
  n("441900004", "南城街道", 4, "441900"),

  n("52", "贵州省", 1, null),
  n("5205", "毕节市", 2, "52"),
  n("520521", "大方县", 3, "5205"),
  n("520521002", "顺德街道", 4, "520521"),

  n("53", "云南省", 1, null),
  n("5301", "昆明市", 2, "53"),
  n("530102", "五华区", 3, "5301"),
  n("530102004", "华山街道", 4, "530102"),
  n("5325", "红河哈尼族彝族自治州", 2, "53"),
  n("532503", "蒙自市", 3, "5325"),
  n("532503001", "文澜街道", 4, "532503"),

  n("15", "内蒙古自治区", 1, null, "region", ["内蒙古"]),
  n("1505", "通辽市", 2, "15"),
  n("150502", "科尔沁区", 3, "1505"),
  n("150502001", "科尔沁街道", 4, "150502"),

  n("42", "湖北省", 1, null),
  n("4290", "省直辖县级行政区划", 2, "42", "group"),
  n("429004", "仙桃市", 3, "4290"),
  n("429004002", "干河街道", 4, "429004"),

  n("41", "河南省", 1, null),
  n("4102", "开封市", 2, "41"),
  n("410204", "鼓楼区", 3, "4102"),
  n("410204001", "相国寺街道", 4, "410204"),

  n("32", "江苏省", 1, null),
  n("3201", "南京市", 2, "32"),
  n("320106", "鼓楼区", 3, "3201"),
  n("320106001", "华侨路街道", 4, "320106"),
  n("3203", "徐州市", 2, "32"),
  n("320302", "鼓楼区", 3, "3203"),
  n("320302001", "夹河街街道", 4, "320302"),

  n("61", "陕西省", 1, null),
  n("6101", "西安市", 2, "61"),
  n("610113", "雁塔区", 3, "6101"),
  n("610113001", "小寨路街道", 4, "610113"),

  n("33", "浙江省", 1, null),
  n("3301", "杭州市", 2, "33"),
  n("330106", "西湖区", 3, "3301"),
  n("330106008", "西湖街道", 4, "330106"),
  n("3302", "宁波市", 2, "33"),
  n("330212", "鄞州区", 3, "3302"),
  n("330212006", "首南街道", 4, "330212"),

  n("50", "重庆市", 1, null),
  n("5001", "市辖区", 2, "50", "group"),
  n("500103", "渝中区", 3, "5001"),
  n("500103001", "七星岗街道", 4, "500103"),
];

export function countLevels(nodes: readonly RegionNode[]): Partial<Record<AdminLevel, number>> {
  const counts: Partial<Record<AdminLevel, number>> = {};
  for (const node of nodes) counts[node.level] = (counts[node.level] ?? 0) + 1;
  return counts;
}

export function fixtureSnapshot(overrides: Partial<RegionSnapshot> = {}): RegionSnapshot {
  return { datasetId: "fixture-ds", version: "fixture-v1", codeScheme: "statistics-source-short-codes", nodes: FIXTURE_NODES, ...overrides };
}

export class FixtureProvider implements RegionProvider {
  readonly source = "area-kit-fixture";
  loadCount = 0;
  constructor(private readonly snapshot: RegionSnapshot = fixtureSnapshot(), private readonly fail?: Error) {}

  async loadSnapshot(): Promise<RegionSnapshot> {
    this.loadCount++;
    if (this.fail) throw this.fail;
    return this.snapshot;
  }

  async validatePath(codes: readonly (string | null)[]): Promise<PathCheck> {
    const problems = codes.filter((c) => c !== null && !this.snapshot.nodes.some((node) => node.code === c)).map((c) => ({ code: String(c), reason: "provider 校验失败" }));
    return { ok: problems.length === 0, problems };
  }
}
