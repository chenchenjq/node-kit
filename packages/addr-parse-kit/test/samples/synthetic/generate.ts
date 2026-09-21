/**
 * 合成样例生成器。
 *
 * 用途**只有一个**：在可控数量下压解析路径，检查「结构性不变量」是否成立
 * （不臆造层级、显式命中必须能在原文定位、推断层级必须带警告、门牌要素不得消失）。
 * 它的地名与门牌是随机拼接的，不承载真值语义，因此**不用于**任何准确率结论；
 * 准确率一律以 annotated/ 的人工标注集为准。
 */
import type { RegionNode } from "../../../src/types.js";

const ELEMENTS = ["东风", "红旗", "解放", "建设", "新兴", "新民", "永兴", "永兴", "白塔", "金水", "玉带", "青云"];
const TYPES = ["路", "街", "大道", "巷"];
const BUILDINGS = ["1 号楼", "2 栋", "A 座", "3 幢", "办公楼"];
const UNITS = ["1 单元", "2 单元", "西单元"];
const ROOMS = ["301", "1205", "负 101", "B2 层"];
const SUFFIX_NOISE = ["（放前台）", " 请工作日送达", " 订单号 88123456789012345678", ""];
const SURNAMES = ["赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈"];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticCase {
  id: string;
  input: string;
  /** 期望被识别出的区划代码，按层级递增。 */
  goldCodes: string[];
  /** 期望出现在 detailedAddress / residualText 里、不允许被吞掉的片段。 */
  mustKeep: string[];
  phone: string | null;
}

export function generateSyntheticCases(nodes: readonly RegionNode[], count: number, seed = 20240918): SyntheticCase[] {
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const leaves = nodes.filter((node) => node.level === 4 && node.kind === "region");
  const chainOf = (node: RegionNode): RegionNode[] => {
    const chain: RegionNode[] = [];
    let cur: RegionNode | undefined = node;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentCode === null ? undefined : byCode.get(cur.parentCode);
    }
    return chain;
  };
  const pick = <T,>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length) % list.length]!;
  const random = mulberry32(seed);
  const cases: SyntheticCase[] = [];

  for (let i = 0; i < count; i++) {
    const leaf = pick(random, leaves);
    const chain = chainOf(leaf).filter((node) => node.kind !== "group");
    // 随机丢掉开头若干级（模拟用户不写省/市），剩下的必须按原文顺序出现。
    const start = Math.floor(random() * chain.length);
    const written = chain.slice(start);
    const road = `${pick(random, ELEMENTS)}${pick(random, TYPES)} ${1 + Math.floor(random() * 999)} 号`;
    const building = pick(random, BUILDINGS);
    const unit = pick(random, UNITS);
    const room = pick(random, ROOMS);
    const name = `${pick(random, SURNAMES)}${pick(random, ["伟", "敏", "磊", "静", "涛"])}`;
    const phone = `1${pick(random, ["3", "5", "8"])}${String(Math.floor(random() * 1e9)).padStart(9, "0")}`;
    const tail = pick(random, SUFFIX_NOISE);
    const detail = [road, building, unit, room].join(" ");
    const withRecipient = random() < 0.7 ? ` ${name} ${phone}` : "";
    cases.push({
      id: `S${String(i).padStart(4, "0")}`,
      input: `${written.map((node) => node.name).join("")} ${detail}${withRecipient}${tail}`,
      goldCodes: written.map((node) => node.code),
      mustKeep: [road, building, unit, room],
      phone: withRecipient ? phone : null,
    });
  }
  return cases;
}
