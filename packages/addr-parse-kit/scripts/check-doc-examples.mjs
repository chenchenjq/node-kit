#!/usr/bin/env node
/**
 * 文档示例类型检查：把 README.md / DATABASE.md / AI-USAGE.md 里的 ```ts 代码块抽出来，
 * 在“已安装 tgz 的宿主目录”里用宿主自己的 tsc 编译一遍。
 * 目的是让文档里出现的每一个 API 名字都真实存在——设计草案不许写成已实现 API。
 *
 *   node scripts/check-doc-examples.mjs --consumer-dir <绝对路径>
 */
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const DOCUMENTS = ["README.md", "DATABASE.md", "AI-USAGE.md"];

function consumerDir(argv) {
  if (argv.length !== 2 || argv[0] !== "--consumer-dir" || !argv[1].startsWith("/")) {
    throw new Error("用法: node scripts/check-doc-examples.mjs --consumer-dir <绝对路径>");
  }
  return resolve(argv[1]);
}

async function requireFile(path) {
  await access(path);
  if (!(await stat(path)).isFile()) throw new Error(`不是文件: ${path}`);
}

const consumer = consumerDir(process.argv.slice(2));
const installed = join(consumer, "node_modules/addr-parse-kit");
const tsc = join(consumer, "node_modules/typescript/bin/tsc");
await requireFile(join(installed, "package.json"));
await requireFile(tsc);

const out = join(consumer, "doc-examples");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const files = [];
for (const document of DOCUMENTS) {
  const text = await readFile(join(installed, document), "utf8");
  const blocks = [...text.matchAll(/```typescript\n([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error(`${document} 没有 typescript 代码示例，文档不可验收`);
  for (const [index, block] of blocks.entries()) {
    const file = join(out, `${document.replace(/\.md$/, "")}-${String(index).padStart(2, "0")}.ts`);
    // 代码块允许是片段：补上顶层 await 需要的模块壳，并固定变量名避免跨块冲突。
    await writeFile(file, `${block[1].trimEnd()}\nexport {};\n`, "utf8");
    files.push(file);
  }
}

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_PATH"));
try {
  const { stdout } = await execute(process.execPath, [
    tsc, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--types", "node", ...files,
  ], { cwd: consumer, env });
  process.stdout.write(`文档示例全部通过类型检查（${files.length} 段）${stdout ? `\n${stdout}` : ""}`);
} catch (error) {
  process.stdout.write(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  throw new Error(`文档示例类型检查失败（${files.length} 段代码）`);
}
