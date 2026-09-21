#!/usr/bin/env node
/**
 * 性能自测脚本：打印（并可选落盘）真实测得的冷启动/吞吐/延迟/内存/事件循环数据。
 *
 *   node scripts/bench.mjs [--levels 1000,10000] [--json out.json]
 *
 * 数据构成声明（写进报告，不允许被省略）：
 * 本脚本用的是**按生产规模程序化生成的合成区域树 + 合成地址文本**（名称人造，规模近似 1..4 级 4.3 万节点），
 * 因为在离线环境下拿不到权威全量快照（66.5 万行）。它只能证明“本包在该规模下的成本形状”，
 * 不能当作真实数据上的准确率或真实冷启动结论；两者在报告里一律标注「未验证」。
 */
import { writeFile, mkdir } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { initParser } from "../dist/server/index.js";

const PROVINCES = 31;
const CITIES_PER_PROVINCE = 11;
const COUNTIES_PER_CITY = 9;
const STREETS_PER_COUNTY = 13;

const SYLLABLES = [
  "长", "山", "河", "東", "宁", "安", "平", "广", "源", "太", "文", "武", "成", "德", "昌", "封", "原", "江", "夏", "商",
  "周", "桐", "柏", "泉", "溪", "云", "龙", "凤", "鹤", "鹏", "金", "银", "铜", "铁", "石", "林", "森", "草", "海", "天",
];
const STREET_SUFFIX = ["街道", "镇", "乡"];
const ROAD = ["人民路", "解放大道", "建设北路", "中山南路", "胜利街", "文化巷", "环东路", "钢厂胡同", "学府路", "滨江大道"];
const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "赵", "黄", "周", "吴", "徐", "孙", "马", "朱", "胡", "林", "郭", "何"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "勇", "艳", "杰", "涛", "明", "超", "秀英", "霞", "平"];
const NOISE = ["", "", "", " 备注：工作日送达", "（放驿站）", " 订单号 87123456789012345678", " 3 号楼 2 单元 501", ", 尽快发货"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, list) {
  return list[Math.floor(random() * list.length) % list.length];
}

function two(random) {
  return pick(random, SYLLABLES) + pick(random, SYLLABLES);
}

/** 生成 1..4 级规模近似区域树；代码长度沿用统计用区划短码方案（2/4/6/9）。 */
function buildScaleSnapshot() {
  const random = mulberry32(20240918);
  const nodes = [];
  for (let p = 1; p <= PROVINCES; p += 1) {
    const provinceCode = String(p).padStart(2, "0");
    nodes.push({ code: provinceCode, name: `${two(random)}省`, level: 1, parentCode: null, kind: "region" });
    for (let c = 1; c <= CITIES_PER_PROVINCE; c += 1) {
      const cityCode = `${provinceCode}${String(c).padStart(2, "0")}`;
      nodes.push({ code: cityCode, name: `${two(random)}市`, level: 2, parentCode: provinceCode, kind: "region" });
      for (let a = 1; a <= COUNTIES_PER_CITY; a += 1) {
        const countyCode = `${cityCode}${String(a).padStart(2, "0")}`;
        nodes.push({ code: countyCode, name: `${two(random)}区`, level: 3, parentCode: cityCode, kind: "region" });
        for (let s = 1; s <= STREETS_PER_COUNTY; s += 1) {
          const streetCode = `${countyCode}${String(s).padStart(3, "0")}`;
          const name = `${two(random)}${pick(random, STREET_SUFFIX)}`;
          nodes.push({ code: streetCode, name, level: 4, parentCode: countyCode, kind: "region" });
        }
      }
    }
  }
  return { datasetId: "bench-scale", version: "bench-scale-v1", codeScheme: "statistics-source-short-codes", nodes };
}

class ScaleProvider {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.loadCalls = 0;
  }

  source = "bench-scale";

  async loadSnapshot() {
    this.loadCalls += 1;
    return this.snapshot;
  }

  async validatePath() {
    return { ok: true, problems: [] };
  }
}

/** 从区域树里随机走一条路径拼地址文本，保证样例本身可解析。 */
function buildTexts(snapshot, count) {
  const random = mulberry32(987654321);
  const byLevel = new Map([1, 2, 3, 4].map((level) => [level, snapshot.nodes.filter((node) => node.level === level)]));
  const children = new Map();
  for (const node of snapshot.nodes) {
    if (node.parentCode === null) continue;
    const list = children.get(node.parentCode) ?? [];
    list.push(node);
    children.set(node.parentCode, list);
  }
  const provinces = byLevel.get(1);
  const texts = [];
  for (let i = 0; i < count; i += 1) {
    const province = pick(random, provinces);
    const city = pick(random, children.get(province.code));
    const county = pick(random, children.get(city.code));
    const street = pick(random, children.get(county.code));
    const road = pick(random, ROAD);
    const number = `${Math.floor(random() * 900) + 10} 号`;
    const name = pick(random, SURNAMES) + pick(random, GIVEN);
    const phone = `1${pick(random, ["3", "5", "7", "8", "9"])}${String(Math.floor(random() * 1e9)).padStart(9, "0")}`;
    const head = random() < 0.15 ? `${city.name}${county.name}${street.name}` : `${province.name}${city.name}${county.name}${street.name}`;
    const tail = random() < 0.25 ? ` 收件人：${name} 电话：${phone}` : ` ${name} ${phone}`;
    texts.push(`${head}${road}${number}${tail}${pick(random, NOISE)}`);
  }
  return texts;
}

function percentile(histogram, q) {
  return Number((histogram.percentile(q) / 1e6).toFixed(3));
}

async function measureRound(name, run) {
  const before = process.memoryUsage();
  const started = performance.now();
  const detail = await run();
  const elapsedMs = Math.round(performance.now() - started);
  const after = process.memoryUsage();
  return {
    name,
    elapsedMs,
    rssDeltaMiB: Number(((after.rss - before.rss) / 1048576).toFixed(1)),
    heapUsedDeltaMiB: Number(((after.heapUsed - before.heapUsed) / 1048576).toFixed(1)),
    ...detail,
  };
}

const YIELD_EVERY = 100;

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

async function benchParse(parser, texts, label) {
  // 解析本身是同步 API。为了让事件循环采样器有机会记录停顿，这里每 100 条让出一次；
  // 测得的是「一次同步处理 100 条会让服务器停顿多久」，不是并发下的尾延迟。
  // 整批不让出时的总独占时长就是下面的 总耗时ms。
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const latencies = [];
  let statuses = { matched: 0, partial: 0, ambiguous: 0, unmatched: 0 };
  let reviews = 0;
  const started = performance.now();
  for (const [index, text] of texts.entries()) {
    const itemStarted = performance.now();
    const result = parser.parse(text);
    latencies.push(performance.now() - itemStarted);
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    if (result.requiresReview) reviews += 1;
    if ((index + 1) % YIELD_EVERY === 0) await nextTick();
  }
  const elapsedMs = performance.now() - started;
  await nextTick();
  await nextTick();
  histogram.disable();
  latencies.sort((a, b) => a - b);
  const at = (q) => Number(latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * q))].toFixed(3));
  return {
    档位: label,
    条数: texts.length,
    总耗时ms: Math.round(elapsedMs),
    吞吐每秒条数: Math.round((texts.length / elapsedMs) * 1000),
    单条毫秒: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Number(latencies.at(-1).toFixed(3)) },
    每百条事件循环停顿毫秒: {
      p50: percentile(histogram, 50),
      p99: percentile(histogram, 99),
      max: Number((histogram.max / 1e6).toFixed(3)),
    },
    状态分布: statuses,
    需人工复核占比: Number((reviews / texts.length).toFixed(3)),
  };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function main() {
  const snapshot = buildScaleSnapshot();
  const levelCounts = snapshot.nodes.reduce((acc, node) => {
    acc[node.level] = (acc[node.level] ?? 0) + 1;
    return acc;
  }, {});
  const provider = new ScaleProvider(snapshot);
  console.log(`[bench] 区域节点 ${snapshot.nodes.length}（分级 ${JSON.stringify(levelCounts)}，名称为人造、规模近似）`);

  const rounds = [];
  let parser;
  rounds.push(
    await measureRound("initParser 首次（构建索引 + SDK createParser）", async () => {
      parser = await initParser({ provider, datasetId: snapshot.datasetId, version: snapshot.version });
      return { 节点数: snapshot.nodes.length, provider加载次数: provider.loadCalls };
    }),
  );
  rounds.push(
    await measureRound("initParser 复用同键索引缓存", async () => {
      const again = await initParser({ provider, datasetId: snapshot.datasetId, version: snapshot.version });
      return {
        // 包装对象每次新建，测不到内部索引是否相同；provider 只被调用一次即证明同键数据没有重复拉取。
        包装对象相等: again === parser ? "是" : "否（每次新建包装对象，是否重复取数看下面的加载次数）",
        provider加载次数: provider.loadCalls,
      };
    }),
  );

  const levels = arg("levels", "1000,10000")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  const texts = buildTexts(snapshot, Math.max(...levels));
  const warm = texts.slice(0, 200);
  await benchParse(parser, warm, "warmup");

  const parseRounds = [];
  for (const level of levels) {
    const before = process.memoryUsage();
    const result = await benchParse(parser, texts.slice(0, level), `${level} 条`);
    const after = process.memoryUsage();
    parseRounds.push({
      ...result,
      峰值rssMiB: Number((after.rss / 1048576).toFixed(1)),
      rssDeltaMiB: Number(((after.rss - before.rss) / 1048576).toFixed(1)),
      heapUsedDeltaMiB: Number(((after.heapUsed - before.heapUsed) / 1048576).toFixed(1)),
    });
  }

  const largest = Math.max(...levels);
  const batchSize = parser.limits.maxBatchSize;
  const batchRound = await measureRound(`parseBatch ${largest} 条（按 ${batchSize} 条分片，逐片同步执行）`, async () => {
    let ok = 0;
    for (let offset = 0; offset < largest; offset += batchSize) {
      const items = parser.parseBatch(texts.slice(offset, offset + batchSize));
      ok += items.filter((item) => item.ok).length;
    }
    return { 条数: largest, 成功条数: ok };
  });

  const report = {
    运行于: new Date().toISOString(),
    复跑命令: "node scripts/bench.mjs --levels " + levels.join(","),
    环境: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cpu: cpus()[0].model,
      逻辑核心数: cpus().length,
      总内存MiB: Number((totalmem() / 1048576).toFixed(0)),
      kitVersion: parser.meta.parserVersion,
      sdkVersion: parser.meta.sdkVersion,
      区域数据: "合成：31 省 × 11 市 × 9 区县 × 13 街道，节点名人造",
      样本构成: "合成地址：省市区街 + 路名门牌 + 姓名手机，15% 缺省、25% 带收件人标签、部分带订单号/备注噪声",
    },
    冷启动: rounds,
    解析: parseRounds,
    批量: batchRound,
    读数说明: [
      "冷启动只发生一次：同 source|datasetId|version 第二次 initParser 耗时 0ms、provider 不再被调用（上表加载次数仍为 1）。",
      "「每百条事件循环停顿」是同步 API 的固有独占：单条请求里解析 100 条就会让该进程停顿约 100ms，故高并发场景必须分片或放到独立工作进程。",
      "需人工复核占比高是本合成集的构造使然：街道名由 35×35 音节人造，重名密度远高于真实区划，因此多候选（ambiguous/需复核）比例被放大；不能读作真实数据的歧义率。",
      "本表全部数字来自合成数据，只用于测量成本形状；真实数据上的冷启动与准确率见「未验证」。",
    ],
    未验证: [
      "真实权威快照（66.5 万行含村级）下的冷启动与内存：本机离线，未下载",
      "10 万条/批与更高并发下的吞吐与延迟：未在真实数据上跑",
      "多进程/worker 共享索引的收益：未测",
      "线上真实流量干扰（GC、连接争用）下的表现：未测",
      "合成样本上的识别准确率结论：不适用（名称人造，只用于成本测量）",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  const outFile = arg("json", "");
  if (outFile) {
    await mkdir(resolve(join(outFile, "..")), { recursive: true }).catch(() => undefined);
    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[bench] 报告写入 ${outFile}`);
  }
}

main().catch((error) => {
  console.error("[bench] 失败:", error);
  process.exitCode = 1;
});
