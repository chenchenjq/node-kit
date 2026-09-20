#!/usr/bin/env node
/**
 * 打包验收：npm pack → 仓库外干净宿主 → 类型 / 入口 / 快照注入 / 断网运行 / 无 area-kit 的 tsc。
 *
 *   node scripts/verify-pack.mjs
 *
 * 只在本机安装 tgz 与公开依赖，不发布、不上传、不连生产库（npm install 需要访问 registry）。
 * 结论写入 artifacts/pack-verification.json。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "artifacts");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_PATH" && key !== "NODE_OPTIONS"));
const GUARD = pathToFileURL(join(root, "scripts/offline-guard.mjs")).href;

const evidence = { passed: false, startedAt: new Date().toISOString(), checks: [] };
const started = Date.now();

function run(command, args, cwd, env = cleanEnv) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) done({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} ${args.slice(0, 2).join(" ")} 失败 (${code})\n${stdout}\n${stderr}`), { stdout, stderr }));
    });
  });
}

async function step(name, fn) {
  const at = Date.now();
  process.stdout.write(`[pack] ${name}\n`);
  try {
    const result = await fn();
    evidence.checks.push({ name, passed: true, elapsedMs: Date.now() - at });
    return result;
  } catch (error) {
    evidence.checks.push({ name, passed: false, elapsedMs: Date.now() - at, failure: error.message });
    throw error;
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await done;
  clearTimeout(timer);
}

function startNext(cwd, env, origin) {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", new URL(origin).port], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  return (async () => {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Next 启动失败：${log}`);
      try {
        if ((await fetch(`${origin}/`)).ok) return child;
      } catch { /* 端口尚未监听 */ }
      await new Promise((done) => setTimeout(done, 500));
    }
    await stop(child);
    throw new Error(`Next 启动超时：${log}`);
  })();
}

/** 注入用的区域快照：与包内演示数据不同 id/版本，用来证明数据由宿主注入、版本被强制校验。 */
function injectedSnapshot() {
  const node = (code, name, level, parentCode, kind = "region") => ({ code, name, level, parentCode, kind });
  return {
    datasetId: "injected-ds",
    version: "injected-v9",
    codeScheme: "statistics-source-short-codes",
    nodes: [
      node("11", "北京市", 1, null), node("1101", "市辖区", 2, "11", "group"), node("110105", "朝阳区", 3, "1101"), node("110105001", "建外街道", 4, "110105"),
      node("32", "江苏省", 1, null), node("3201", "南京市", 2, "32"), node("320106", "鼓楼区", 3, "3201"), node("320106001", "华侨路街道", 4, "320106"),
      node("3203", "徐州市", 2, "32"), node("320302", "鼓楼区", 3, "3203"), node("320302001", "夹河街街道", 4, "320302"),
      node("44", "广东省", 1, null), node("4403", "深圳市", 2, "44"), node("440305", "南山区", 3, "4403"), node("440305007", "粤海街道", 4, "440305"),
    ],
  };
}

const OFFLINE_PATTERNS = /server-only|cannot run in a browser|No matching export|Client Component|use client/i;

try {
  await mkdir(artifacts, { recursive: true });
  const workspace = await mkdtemp(join(tmpdir(), "addr-parse-pack-"));
  const injectedFile = join(workspace, "injected-area-snapshot.json");
  await writeFile(injectedFile, `${JSON.stringify(injectedSnapshot())}\n`);
  const session = `pack-${Date.now()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  Object.assign(evidence, { workspace, injectedFile, session, origin });

  const hostEnv = (extra = {}) => ({
    ...cleanEnv,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    ADDR_PARSE_SNAPSHOT: injectedFile,
    ADDR_PARSE_DEMO_SESSION: session,
    ...extra,
  });

  await step("build", () => run("npm", ["run", "build"], root));

  const tarball = await step("npm pack + 清单检查", async () => {
    const manifest = await readFile(join(root, "package.json"), "utf8");
    const pkg = JSON.parse(manifest);
    assert.equal(pkg.private, true, "包必须保持 private，避免意外发布");
    assert(!("publishConfig" in pkg), "包不应配置 publishConfig");
    assert(!manifest.includes("registry."), "包清单里不应出现 registry 地址");
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", artifacts], root);
    const packed = JSON.parse(stdout)[0];
    const file = join(artifacts, packed.filename);
    const sha = createHash("sha256").update(await readFile(file)).digest("hex");
    evidence.sha256 = sha;
    evidence.packedFiles = packed.files.map((entry) => entry.path);
    await copyFile(file, join(artifacts, `${sha}.tgz`));
    for (const required of [
      "dist/index.js", "dist/index.d.ts", "dist/server/index.js", "dist/server/index.d.ts", "dist/browser-forbidden.js",
      "scripts/export-snapshot.mjs", "examples/area-kit-provider.ts", "examples/next/app/page.tsx", "examples/next/data/area-snapshot.demo.json",
      "README.md", "DATABASE.md", "AI-USAGE.md",
    ]) assert(evidence.packedFiles.includes(required), `tgz 缺少 ${required}`);
    assert(!evidence.packedFiles.some((path) => /(^|\/)(test|artifacts|node_modules|\.npmrc|\.env)(\/|$)/.test(path)), "tgz 混入了测试/构建/凭据目录");
    assert(!evidence.packedFiles.some((path) => /\.(csv|jsonl|pem|key)$/.test(path)), "tgz 混入了源数据或密钥文件");
    assert(!evidence.packedFiles.some((path) => path.startsWith("dist/") && path.endsWith(".map")), "tgz 混入了 sourcemap");
    return join(artifacts, `${sha}.tgz`);
  });

  const host = await step("干净宿主安装（仓库外）", async () => {
    const dir = join(workspace, "host");
    await mkdir(dir);
    const deps = JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies;
    const wanted = ["next", "react", "react-dom", "typescript", "@types/node", "@types/react", "@types/react-dom", "drizzle-orm", "pg", "@types/pg"];
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "addr-parse-clean-host",
      private: true,
      type: "module",
      dependencies: { "addr-parse-kit": `file:${tarball}`, ...Object.fromEntries(wanted.map((name) => [name, deps[name]])) },
    }, null, 2));
    await run("npm", ["install", "--no-audit", "--no-fund"], dir);
    const installed = await realpath(join(dir, "node_modules/addr-parse-kit"));
    assert(installed.startsWith(dir), `addr-parse-kit 没有真实安装进宿主，而是链接到了工作区：${installed}`);
    evidence.installed = installed;
    return dir;
  });

  await step("无 area-kit 依赖 + 双入口可用", async () => {
    await writeFile(join(host, "entry.mjs"), `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// 宿主为跑文档示例（DATABASE.md 的 Drizzle 表定义）确实装了 pg/drizzle-orm；这里只要求区域包与测试容器不可见。
for (const hidden of ["area-kit", "testcontainers"]) {
  assert.throws(() => require.resolve(hidden), /Cannot find module/, "宿主被隐式链接到了 " + hidden);
}
const server = await import("addr-parse-kit/server");
const browser = await import("addr-parse-kit");
for (const name of ["initParser", "ParseKitError"]) assert.equal(typeof server[name], "function", "server 入口缺少 " + name);
for (const name of ["formatAddress", "formatRecipientLine", "toWithStreet", "toWithoutStreet", "validateAddressIntegrity"]) {
  assert.equal(typeof browser[name], "function", "根入口缺少 " + name);
}
assert.equal(browser.initParser, undefined, "根入口不应带服务端解析器");
assert.equal(browser.DEFAULT_LIMITS, undefined, "根入口不应带服务端限额");
assert.equal(server.DEFAULT_LIMITS.maxBatchSize, 100);
console.log("ENTRY_OK");
`);
    await run("node", ["entry.mjs"], host);
  });

  await step("复制示例与参考实现到宿主", async () => {
    await cp(join(evidence.installed, "examples/next"), host, { recursive: true });
    await mkdir(join(host, "ref-examples"));
    await copyFile(join(evidence.installed, "examples/area-kit-provider.ts"), join(host, "ref-examples/area-kit-provider.ts"));
    await writeFile(join(host, "ref-examples/usage.ts"), `
import { initParser, type AddrParser, type RegionProvider } from "addr-parse-kit/server";
import { formatAddress, toWithoutStreet, type RegionSnapshot } from "addr-parse-kit";

export async function buildParser(provider: RegionProvider, datasetId: string, version: string): Promise<AddrParser> {
  return await initParser({ provider, datasetId, version });
}

export function summarize(parser: AddrParser, text: string): string {
  const result = parser.parse(text, { maxCandidates: 3 });
  return result.candidates.map((candidate) => \`\${candidate.rank}·\${candidate.status}·\${formatAddress(toWithoutStreet(candidate))}\`).join(" | ") + " @ " + result.meta.datasetId;
}

export function snapshotCount(snapshot: RegionSnapshot): number {
  return snapshot.nodes.length;
}
`);
    await writeFile(join(host, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        esModuleInterop: true,
        allowJs: true,
        resolveJsonModule: true,
        isolatedModules: true,
        types: ["node"],
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        plugins: [{ name: "next" }],
      },
      include: ["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "ref-examples/**/*.ts", "global.d.ts"],
    }, null, 2));
  });

  await step("文档示例类型检查（对照安装后的真实导出）", () =>
    run(process.execPath, [join(root, "scripts/check-doc-examples.mjs"), "--consumer-dir", host], host));

  await step("宿主 tsc 通过（未安装 area-kit）", () => run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], host));

  await step("客户端越界导入 server 入口被 next build 拒绝", async () => {
    await mkdir(join(host, "app", "boundary"));
    await writeFile(join(host, "app", "boundary", "page.tsx"), `'use client';\nimport { initParser } from "addr-parse-kit/server";\nexport default function Page() { return <p>{String(initParser)}</p>; }\n`);
    let failure = "";
    try {
      await run(process.execPath, ["node_modules/next/dist/bin/next", "build"], host, hostEnv({ ADDR_PARSE_NEXT_DIST: ".negative-server-import" }));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await rm(join(host, "app", "boundary"), { recursive: true, force: true });
    assert(failure !== "", "客户端组件导入 server 入口却构建成功");
    assert(OFFLINE_PATTERNS.test(failure), `越界导入的报错不符合预期：${failure.slice(0, 500)}`);
    assert(!/Cannot find module 'addr-parse-kit/.test(failure), "报错说明入口解析失败而不是服务端护栏生效");
    await writeFile(join(artifacts, "next-negative-server-import.log"), failure);
  });

  await step("Node 侧解析断言（注入快照 + 错误码 + 断网守卫）", async () => {
    await writeFile(join(host, "smoke.mjs"), smokeSource());
    const offlineLog = join(artifacts, "offline-node-requests.jsonl");
    await writeFile(offlineLog, "");
    const { stdout } = await run("node", ["smoke.mjs"], host, hostEnv({
      ADDR_OFFLINE_LOG: offlineLog,
      ADDR_TEST_HOST: "127.0.0.1",
      NODE_OPTIONS: `--import=${GUARD}`,
    }));
    evidence.smoke = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    assert.equal(await readFile(offlineLog, "utf8"), "", "解析过程尝试了外部连接");
  });

  await step("示例站点生产构建", () => run(process.execPath, ["node_modules/next/dist/bin/next", "build"], host, hostEnv()));

  let server = null;
  try {
    server = await step("联网态 HTTP：认证 → 解析 → 校验 → 确认", async () => {
      const child = await startNext(host, hostEnv(), origin);
      evidence.httpOnline = await httpChecks("联网态", origin, session);
      return child;
    });
    await stop(server);
    server = null;

    const offlineLog = join(artifacts, "offline-http-requests.jsonl");
    await writeFile(offlineLog, "");
    server = await step("断网态 HTTP：重启后仍可解析与确认", async () => {
      const child = await startNext(host, hostEnv({
        NODE_OPTIONS: `--import=${GUARD}`,
        ADDR_OFFLINE_LOG: offlineLog,
        ADDR_TEST_HOST: "127.0.0.1",
        ADDR_PARSE_DEMO_RATE_LIMIT: "20",
      }), origin);
      evidence.httpOffline = await httpChecks("断网态", origin, session);
      return child;
    });
    await step("断网态限流仍由宿主生效", async () => {
      const codes = [];
      for (let i = 0; i < 25; i++) {
        const response = await fetch(`${origin}/api/regions`, { headers: { cookie: `addr_parse_session=${session}` } });
        codes.push(response.status);
      }
      assert(codes.includes(200), "区域接口断网态不可用");
      assert(codes.includes(429), "宿主限流桩未生效");
      assert.equal(await readFile(offlineLog, "utf8"), "", "示例站点在断网守卫下尝试了外部连接");
    });
  } finally {
    await stop(server);
  }

  await step("export-snapshot 可由宿主 provider 驱动", async () => {
    await writeFile(join(host, "snapshot-provider.mjs"), `
import { readFile } from "node:fs/promises";
const snapshot = JSON.parse(await readFile(process.env.ADDR_PARSE_SNAPSHOT, "utf8"));
export default {
  source: "exported-from-injected",
  async loadSnapshot() { return snapshot; },
  async validatePath() { return { ok: true, problems: [] }; },
};
`);
    const out = join(workspace, "re-exported.json");
    const { stderr } = await run(process.execPath, ["node_modules/addr-parse-kit/scripts/export-snapshot.mjs",
      "--provider", "./snapshot-provider.mjs", "--dataset-id", "injected-ds", "--version", "injected-v9", "--out", out], host, hostEnv());
    await writeFile(join(artifacts, "export-snapshot.log"), stderr);
    const reExported = JSON.parse(await readFile(out, "utf8"));
    assert.equal(reExported.nodeCount, injectedSnapshot().nodes.length, "export-snapshot 输出节点数不一致");
    assert.equal(reExported.version, "injected-v9");
    assert(reExported.source === "exported-from-injected");
    const mismatch = await run(process.execPath, ["node_modules/addr-parse-kit/scripts/export-snapshot.mjs",
      "--provider", "./snapshot-provider.mjs", "--dataset-id", "injected-ds", "--version", "wrong-version", "--out", join(workspace, "never.json")], host, hostEnv())
      .then(() => null, (error) => error);
    assert(mismatch !== null && /与请求/.test(mismatch.message ?? ""), "export-snapshot 未拒绝版本不一致的快照");
    await assert.rejects(readFile(join(workspace, "never.json")), "版本不一致时不应写出快照文件");
  });

  evidence.passed = true;
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  console.error(`[pack] 失败：${evidence.failure}`);
  process.exitCode = 1;
} finally {
  evidence.elapsedMs = Date.now() - started;
  await writeFile(join(artifacts, "pack-verification.json"), JSON.stringify(evidence, null, 2));
  // 干净宿主里有完整的 node_modules 与 Next 构建产物；通过后就回收，失败时保留下来排查（TMPDIR 常是 2G tmpfs）。
  if (evidence.passed) {
    await rm(evidence.workspace, { recursive: true, force: true });
    evidence.workspaceRemoved = true;
    await writeFile(join(artifacts, "pack-verification.json"), JSON.stringify(evidence, null, 2));
  }
  console.log(`[pack] ${evidence.passed ? "PASS" : "FAIL"} 证据目录：${artifacts}（${Math.round(evidence.elapsedMs / 1000)}s）${evidence.passed ? "" : ` 工作区保留在 ${evidence.workspace}`}`);
}

/** HTTP 端到端断言：认证、注入快照、区域校验、确认落库、输入上限、页面渲染。 */
async function httpChecks(label, origin, session) {
  const cookie = `addr_parse_session=${session}`;
  const headers = { "content-type": "application/json", cookie };
  const anonymous = await fetch(`${origin}/api/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "广东省深圳市南山区粤海街道 1 号 张三 13800001111" }) });
  assert.equal(anonymous.status, 401, `${label}: 未认证请求必须被宿主拒绝`);

  const parsed = await fetch(`${origin}/api/parse`, { method: "POST", headers, body: JSON.stringify({ text: "广东省深圳市南山区粤海街道科技园南路 18 号 王小满 13800001111" }) });
  assert.equal(parsed.status, 200, `${label}: 解析请求失败`);
  const body = await parsed.json();
  assert.equal(body.data.meta.datasetId, "injected-ds", `${label}: 未使用宿主注入的快照`);
  const candidate = body.data.candidates[0];
  assert.equal(candidate.street.code, "440305007", `${label}: 街道槽位不正确`);
  assert.equal(candidate.recipient.name, "王小满", `${label}: 收件人未提取`);
  assert.ok(candidate.detailedAddress.includes("18 号"), `${label}: 门牌被吞`);

  const truncated = await fetch(`${origin}/api/parse`, { method: "POST", headers, body: JSON.stringify({ text: "鼓楼区 中山北路 100 号 李静 13900002222", maxCandidates: 1 }) });
  const truncatedBody = await truncated.json();
  assert.equal(truncatedBody.data.candidates.length, 1);
  assert.ok(truncatedBody.data.candidates[0].warnings.some((w) => w.code === "CANDIDATES_TRUNCATED"), `${label}: 候选截断未告警`);

  const badPath = await fetch(`${origin}/api/validate`, { method: "POST", headers, body: JSON.stringify({ codes: ["44", "4403", "110105"] }) });
  assert.equal((await badPath.json()).data.ok, false, `${label}: 跨区域路径必须校验失败`);

  const payload = {
    candidateId: candidate.candidateId,
    view: "withStreet",
    parseStatus: candidate.status,
    requiresReview: candidate.requiresReview,
    manualEdits: false,
    province: { code: "44", name: "广东省", level: 1 },
    city: { code: "4403", name: "深圳市", level: 2 },
    district: { code: "440305", name: "南山区", level: 3 },
    street: { code: "440305007", name: "粤海街道", level: 4 },
    regionGroup: null,
    detailedAddress: candidate.detailedAddress,
    recipient: { name: candidate.recipient.name, phone: candidate.recipient.phone },
    warnings: candidate.warnings.map((w) => w.code),
    meta: { regionSource: body.data.meta.regionSource, datasetId: body.data.meta.datasetId, regionVersion: body.data.meta.regionVersion, codeScheme: body.data.meta.codeScheme },
  };
  const confirmed = await fetch(`${origin}/api/confirm`, { method: "POST", headers, body: JSON.stringify(payload) });
  assert.equal(confirmed.status, 200, `${label}: 确认保存失败`);
  const record = (await confirmed.json()).data;
  assert.equal(record.provinceCode, "44");
  assert.equal(record.streetCode, "440305007");
  assert.equal(record.regionDatasetId, "injected-ds");
  assert.equal(record.parserVersion, "0.0.0", `${label}: 包版本必须由服务端补齐`);

  const stale = await fetch(`${origin}/api/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, district: { code: "440305", name: "新名字区", level: 3 } }),
  });
  assert.equal(stale.status, 400, `${label}: “新名称 + 旧代码”必须被拒绝`);
  assert.equal((await stale.json()).error.code, "E_REGION_SELECTION_INVALID");

  const forgedVersion = await fetch(`${origin}/api/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, meta: { ...payload.meta, regionVersion: "别的版本" } }),
  });
  assert.equal(forgedVersion.status, 400, `${label}: 浏览器伪造区域版本必须被拒绝`);

  const tooLong = await fetch(`${origin}/api/parse`, { method: "POST", headers, body: JSON.stringify({ text: "广".repeat(5000) }) });
  assert.equal((await tooLong.json()).error.code, "E_INPUT_TOO_LONG", `${label}: 输入长度上限未生效`);

  const html = await fetch(`${origin}/`);
  assert.ok(html.ok && (await html.text()).includes("addr-parse-kit 示例"), `${label}: 示例页面未渲染`);
  return { candidateId: candidate.candidateId, recordId: record.id };
}

/** 在干净宿主里执行的解析断言；最后一行输出 JSON 供证据文件记录。声明为函数以便上面的步骤引用。 */
function smokeSource() {
  return `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { initParser, ParseKitError, DEFAULT_LIMITS } from "addr-parse-kit/server";
import { formatAddress, formatRecipientLine, toWithStreet, toWithoutStreet, validateAddressIntegrity } from "addr-parse-kit";

const snapshot = JSON.parse(await readFile(process.env.ADDR_PARSE_SNAPSHOT, "utf8"));
const parents = new Map(snapshot.nodes.map((node) => [node.code, node.parentCode]));
function chain(code) {
  const out = new Set();
  let cursor = code;
  while (cursor !== null && cursor !== undefined) {
    out.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return out;
}
const provider = {
  source: "injected-json",
  async loadSnapshot() { return snapshot; },
  async validatePath(codes) {
    const filled = codes.filter((code) => typeof code === "string" && code.length > 0);
    if (!filled.length) return { ok: false, problems: [{ code: "", reason: "未提供代码" }] };
    const ancestors = chain(filled[filled.length - 1]);
    return { ok: filled.every((code) => ancestors.has(code)), problems: filled.filter((code) => !ancestors.has(code)).map((code) => ({ code, reason: "不在路径上" })) };
  },
};

const parser = await initParser({ provider, datasetId: snapshot.datasetId, version: snapshot.version });
assert.equal(parser.meta.regionSource, "injected-json", "meta 未反映宿主注入的数据源");
assert.equal(parser.meta.datasetId, "injected-ds");
assert.equal(parser.meta.regionVersion, "injected-v9");
assert.deepEqual(parser.limits, DEFAULT_LIMITS);

// 版本必须由宿主显式钉住；provider 返回别的版本时不得静默采用。
await assert.rejects(initParser({ provider, datasetId: "other", version: "other" }), (error) => error instanceof ParseKitError && error.code === "E_REGION_VERSION_MISMATCH");
await assert.rejects(initParser({ provider: { source: "x" }, datasetId: "a", version: "b" }), (error) => error.code === "E_REGION_INIT");
await assert.rejects(initParser({
  provider: { source: "x", loadSnapshot: async () => { throw new Error("区域库不可达"); }, validatePath: async () => ({ ok: true, problems: [] }) },
  datasetId: "a", version: "b",
}), (error) => error.code === "E_REGION_INIT");
await assert.rejects(initParser({
  provider: { source: "empty", loadSnapshot: async () => ({ datasetId: "a", version: "b", codeScheme: "c", nodes: [] }), validatePath: async () => ({ ok: true, problems: [] }) },
  datasetId: "a", version: "b",
}), (error) => error.code === "E_SNAPSHOT_INVALID");

const standard = parser.parse("广东省深圳市南山区粤海街道科技园南路 18 号 3 栋 1205 王小满 13800001111");
assert.equal(standard.status, "matched");
const first = standard.candidates[0];
assert.equal(first.province.code, "44");
assert.equal(first.city.code, "4403");
assert.equal(first.district.code, "440305");
assert.equal(first.street.code, "440305007");
assert.deepEqual(validateAddressIntegrity(first), []);
for (const token of ["科技园南路", "18 号", "3 栋", "1205"]) assert(first.detailedAddress.includes(token), "门牌信息被吞掉：" + first.detailedAddress);
assert.equal(first.recipient.name, "王小满");
assert.equal(first.recipient.phone, "13800001111");
assert.equal(first.recipient.extraPhones, undefined);
for (const span of [first.province, first.city, first.district, first.street]) {
  if (span?.matchedRange === undefined) continue;
  const [begin, end] = span.matchedRange;
  assert.equal(standard.input.slice(begin, end), span.matchedText, "span 与原文不一致");
}

// 歧义：裸名重名区县应给多条候选 + 必标复核，且不自动收敛成一条。
const ambiguous = parser.parse("鼓楼区 中山北路 100 号 徐明 13200008888");
assert.ok(ambiguous.candidates.length > 1, "重名区县应给出多条候选");
assert.equal(ambiguous.status, "ambiguous");
assert.equal(ambiguous.requiresReview, true);
assert.ok(ambiguous.warnings.some((warning) => warning.code === "AMBIGUOUS"));
const truncated = parser.parse("鼓楼区 中山北路 100 号 徐明 13200008888", { maxCandidates: 1 });
assert.equal(truncated.candidates.length, 1);
assert.ok(truncated.candidates[0].warnings.some((warning) => warning.code === "CANDIDATES_TRUNCATED"), "候选被截断但未告警");

// 模式切换：街道并回详细地址，可无损复原。
const folded = toWithoutStreet(first);
assert.equal(folded.street, null);
assert.ok(folded.detailedAddress.startsWith("粤海街道"), "街道文本未并回详细地址");
assert.ok(folded.streetFolded);
assert.deepEqual(validateAddressIntegrity(folded), []);
const restored = toWithStreet(folded);
assert.deepEqual(restored, first);
assert.equal(formatAddress(restored, { mode: "withoutStreet" }), formatAddress(folded));
assert.ok(formatRecipientLine(restored).includes("王小满"));

// 不提取收件人 / 完全不匹配：只回原文，不猜数据。
const suppressed = parser.parse("江苏省南京市鼓楼区 1 号", { extractRecipient: false });
assert.equal(suppressed.candidates[0].recipient, null);
const unmatched = parser.parse("公司地址面议 请联系招商部");
assert.equal(unmatched.status, "unmatched");
assert.equal(unmatched.candidates.length, 1);
assert.equal(unmatched.candidates[0].province, null);
assert.equal(unmatched.candidates[0].city, null);

// 路径校验只认宿主快照里的父子关系。
assert.equal(parser.validateSelection(["44", "4403", "440305", "440305007"]).ok, true);
assert.equal(parser.validateSelection(["44", "4403", "110105"]).ok, false);
assert.equal(parser.validateSelection(["44", "999999"]).ok, false);

// 输入边界一律显式报错，不静默截断。
assert.throws(() => parser.parse("   "), (error) => error.code === "E_INPUT_EMPTY");
assert.throws(() => parser.parse("广".repeat(DEFAULT_LIMITS.maxTextLength + 1)), (error) => error.code === "E_INPUT_TOO_LONG");
assert.throws(() => parser.parse("广东省", { maxCandidates: 0 }), (error) => error.code === "E_MAX_CANDIDATES");
assert.throws(() => parser.parse("广东省", { maxCandidates: DEFAULT_LIMITS.maxCandidatesHardCap + 1 }), (error) => error.code === "E_MAX_CANDIDATES");
assert.throws(() => parser.parseBatch(Array.from({ length: DEFAULT_LIMITS.maxBatchSize + 1 }, () => "广东省深圳市")), (error) => error.code === "E_BATCH_TOO_LARGE");
assert.throws(() => parser.parseBatch("广东省深圳市"), (error) => error.code === "E_BATCH_NOT_ARRAY");
const batch = parser.parseBatch(["广东省深圳市南山区粤海街道 1 号 张三 13800001111", "   ", "公司地址面议"], {}, ["r1", "r2", "r3"]);
assert.equal(batch.length, 3);
assert.equal(batch[0].ok, true);
assert.equal(batch[0].recordId, "r1");
assert.equal(batch[1].ok, false);
assert.equal(batch[1].error.code, "E_INPUT_EMPTY");
assert.equal(batch[2].result.status, "unmatched");

// 区域提示不得覆盖原文明示的区域。
const hinted = parser.parse("广东省深圳市南山区粤海街道 1 号", { regionHint: { provinceCode: "11" } });
assert.equal(hinted.candidates[0].province.code, "44");

console.log(JSON.stringify({ ok: true, nodes: snapshot.nodes.length, standard: first.candidateId, candidates: ambiguous.candidates.length }));
`;
}
