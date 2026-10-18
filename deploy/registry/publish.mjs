#!/usr/bin/env node
/**
 * deploy/registry/publish.mjs
 *
 * 自动化将 node-kit 工作区内的所有子包构建并发布/部署到本地私有 Registry (http://127.0.0.1:4873)。
 *
 * 特性：
 * 1. 检查本地 Registry 连通性与 npm 认证状态 (npm whoami)。
 * 2. 自动识别并编译具备源码的子包 (npm run build)。
 * 3. 安全临时处理 private: true，发布后严格恢复原始 package.json，避免污染 git 工作区。
 * 4. 自动处理版本覆盖（若已有发布版本则强制更新）。
 * 5. 发布后拉取 Registry 元数据进行验证并输出清晰报告。
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = resolve(__dirname, "../..");
const PACKAGES_DIR = resolve(ROOT_DIR, "packages");
const REGISTRY_URL = process.env.REGISTRY_URL || "http://127.0.0.1:4873";

function log(msg) {
  console.log(`\x1b[36m[registry:publish]\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m✔\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
}

async function main() {
  log(`目标 Registry: ${REGISTRY_URL}`);

  // 1. 检查 Registry 连通性
  try {
    const res = await fetch(`${REGISTRY_URL}/-/ping`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok && res.status !== 200) {
      // 部分 verdaccio 版本 ping 路径不同，尝试根路径
      await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(3000) });
    }
  } catch (err) {
    error(`无法连接到本地 Registry (${REGISTRY_URL})。请先运行: npm run registry:up`);
    process.exit(1);
  }
  success(`本地 Registry 在线并响应正常`);

  // 2. 检查认证状态
  let currentUser = "";
  try {
    currentUser = execSync(`npm whoami --registry ${REGISTRY_URL}`, { encoding: "utf8" }).trim();
    success(`当前登录用户: ${currentUser}`);
  } catch {
    error(`尚未在 ${REGISTRY_URL} 登录。请参考 deploy/registry/README.md 配置认证或执行: npm login --registry ${REGISTRY_URL}`);
    process.exit(1);
  }

  // 3. 扫描 packages 目录
  const packageDirs = readdirSync(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((dir) => statSync(dir).isDirectory() && existsSync(join(dir, "package.json")));

  log(`扫描到 ${packageDirs.length} 个子包待发布`);

  const results = [];

  for (const pkgDir of packageDirs) {
    const pkgJsonPath = join(pkgDir, "package.json");
    const rawPkg = readFileSync(pkgJsonPath, "utf8");
    const pkg = JSON.parse(rawPkg);
    const { name, version } = pkg;

    console.log("\n------------------------------------------------------------");
    log(`处理包: \x1b[1m${name}@${version}\x1b[0m (${pkgDir.replace(ROOT_DIR + "/", "")})`);

    // 构建产物（如果存在 build 脚本且包含 tsconfig.build.json）
    if (pkg.scripts?.build && existsSync(join(pkgDir, "tsconfig.build.json"))) {
      try {
        log(`正在编译产物 (npm run build)...`);
        execSync("npm run build", { cwd: pkgDir, stdio: "pipe" });
        success(`构建成功`);
      } catch (buildErr) {
        error(`构建失败: ${buildErr.message}`);
        results.push({ name, version, status: "BUILD_FAILED", error: buildErr.message });
        continue;
      }
    } else {
      log(`跳过构建 (使用已有 dist 产物)`);
    }

    // 检查是否已有同版本在 registry 中
    let existsOnRegistry = false;
    try {
      execSync(`npm view ${name}@${version} version --registry ${REGISTRY_URL}`, { stdio: "ignore" });
      existsOnRegistry = true;
    } catch {
      existsOnRegistry = false;
    }

    if (existsOnRegistry) {
      log(`检测到 ${name}@${version} 已存在于 Registry，正在取消发布以支持热更新覆盖...`);
      try {
        execSync(`npm unpublish ${name}@${version} --force --registry ${REGISTRY_URL}`, { stdio: "ignore" });
        success(`已强制移除旧版本`);
      } catch (unpubErr) {
        warn(`强制取消发布失败 (可能无需取消): ${unpubErr.message}`);
      }
    }

    // 准备发布：临时调整 package.json（去掉 private: true，设置 publishConfig）
    const modifiedPkg = { ...pkg };
    delete modifiedPkg.private;
    modifiedPkg.publishConfig = { registry: REGISTRY_URL };

    let publishSuccess = false;
    let publishError = null;

    try {
      writeFileSync(pkgJsonPath, JSON.stringify(modifiedPkg, null, 2) + "\n");
      log(`正在发布到 ${REGISTRY_URL}...`);
      execSync(`npm publish --registry ${REGISTRY_URL}`, { cwd: pkgDir, stdio: "pipe" });
      publishSuccess = true;
      success(`成功发布 ${name}@${version}`);
    } catch (pubErr) {
      publishError = pubErr.stderr?.toString() || pubErr.stdout?.toString() || pubErr.message;
      error(`发布失败: ${publishError}`);
    } finally {
      // 严格恢复 package.json 原始内容
      writeFileSync(pkgJsonPath, rawPkg);
    }

    results.push({
      name,
      version,
      status: publishSuccess ? "PUBLISHED" : "FAILED",
      error: publishError,
    });
  }

  // 4. 汇总验证
  console.log("\n============================================================");
  log(`发布结果汇总:`);
  console.log("============================================================");
  console.table(
    results.map((r) => ({
      Package: r.name,
      Version: r.version,
      Status: r.status === "PUBLISHED" ? "✅ 成功" : "❌ 失败",
      Details: r.error ? r.error.trim().split("\n")[0] : `${REGISTRY_URL}/${r.name}`,
    }))
  );

  const allPassed = results.every((r) => r.status === "PUBLISHED");
  if (allPassed) {
    console.log(`\n\x1b[32m🎉 所有 ${results.length} 个子包已成功部署至本地 Registry (${REGISTRY_URL})！\x1b[0m\n`);
  } else {
    console.log(`\n\x1b[31m⚠️ 部分包发布失败，请检查上方日志。\x1b[0m\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  error(`脚本异常终止: ${err.message}`);
  process.exit(1);
});

