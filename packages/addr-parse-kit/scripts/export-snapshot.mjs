#!/usr/bin/env node
/**
 * 把宿主 RegionProvider 的区域数据预导出为 JSON 快照，供 createJsonSnapshotProvider 离线加载。
 * 本脚本不连接任何数据库，也不依赖 area-kit：区域数据从哪来由 --provider 模块决定。
 *
 *   node node_modules/addr-parse-kit/scripts/export-snapshot.mjs \
 *     --provider ./my-provider.mjs --dataset-id <datasetId> --version <versionCode> --out ./area-snapshot.json
 *
 * --provider 模块需 default 导出 RegionProvider，或导出一个返回 RegionProvider 的（异步）工厂函数。
 */
import { pathToFileURL } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REQUIRED = ["provider", "datasetId", "version", "out"];
const ALIAS_LEVELS = [1, 2, 3, 4];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) throw new Error(`无法识别的参数: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 --${token.slice(2)} 缺少取值`);
    args[key] = value;
    i += 1;
  }
  const missing = REQUIRED.filter((name) => !args[name]);
  if (missing.length) throw new Error(`缺少必填参数: ${missing.map((m) => `--${m.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(" ")}`);
  return args;
}

function validateSnapshot(snapshot, datasetId, version) {
  if (typeof snapshot !== "object" || snapshot === null) throw new Error("provider.loadSnapshot 未返回快照对象");
  if (snapshot.datasetId !== datasetId || snapshot.version !== version) {
    throw new Error(`provider 返回快照 ${snapshot.datasetId}/${snapshot.version}，与请求 ${datasetId}/${version} 不一致`);
  }
  if (typeof snapshot.codeScheme !== "string" || !snapshot.codeScheme) throw new Error("快照缺少 codeScheme");
  if (!Array.isArray(snapshot.nodes) || !snapshot.nodes.length) throw new Error("快照 nodes 为空，拒绝导出（不静默回退到其他数据源）");
  const codes = new Set();
  for (const node of snapshot.nodes) {
    if (typeof node?.code !== "string" || !node.code) throw new Error("快照存在非法节点代码");
    if (codes.has(node.code)) throw new Error(`快照节点代码重复: ${node.code}`);
    codes.add(node.code);
    if (!ALIAS_LEVELS.includes(node.level) && node.level !== 5) throw new Error(`快照节点 ${node.code} 的 level 非法: ${node.level}`);
  }
  for (const node of snapshot.nodes) {
    if (node.level !== 1 && !codes.has(node.parentCode)) throw new Error(`快照节点 ${node.code} 的父级 ${node.parentCode} 不在快照内`);
  }
}

const usage = () => {
  console.error("用法: export-snapshot --provider <模块路径> --dataset-id <id> --version <版本> --out <文件>");
  console.error("本脚本不读写数据库，也不输出任何收件人信息。");
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const providerModule = await import(pathToFileURL(resolve(process.cwd(), args.provider)).href);
  const exported = providerModule.default;
  const provider = typeof exported === "function" ? await exported() : exported;
  if (!provider || typeof provider.loadSnapshot !== "function" || typeof provider.validatePath !== "function" || !provider.source) {
    throw new Error("--provider 模块必须 default 导出 RegionProvider（source/loadSnapshot/validatePath）或其工厂函数");
  }

  const startedAt = Date.now();
  const snapshot = await provider.loadSnapshot({ datasetId: args.datasetId, version: args.version });
  validateSnapshot(snapshot, args.datasetId, args.version);
  const coldStartMs = Date.now() - startedAt;

  const out = resolve(process.cwd(), args.out);
  await mkdir(dirname(out), { recursive: true });
  const payload = {
    source: provider.source,
    exportedAt: new Date().toISOString(),
    datasetId: snapshot.datasetId,
    version: snapshot.version,
    codeScheme: snapshot.codeScheme,
    stats: typeof provider.stats === "function" ? (provider.stats() ?? null) : null,
    nodeCount: snapshot.nodes.length,
    levelCounts: snapshot.nodes.reduce((acc, node) => {
      acc[node.level] = (acc[node.level] ?? 0) + 1;
      return acc;
    }, {}),
    nodes: snapshot.nodes,
  };
  await writeFile(out, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(
    `[export-snapshot] source=${provider.source} datasetId=${snapshot.datasetId} version=${snapshot.version} ` +
      `nodes=${snapshot.nodes.length} coldStartMs=${coldStartMs} -> ${out}`,
  );
}

main().catch((error) => {
  usage();
  console.error(`[export-snapshot] 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
