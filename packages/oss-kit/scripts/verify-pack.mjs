import { mkdtemp, mkdir, readFile, writeFile, cp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { run } from "./run.mjs";
import { withPostgres } from "./with-postgres.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)), artifacts = resolve(root, "artifacts");
await mkdir(artifacts, { recursive: true });
await run("npm", ["run", "build"], root);
await run("npm", ["pack", "--pack-destination", artifacts], root);
const consumer = await mkdtemp(join(tmpdir(), "oss-kit-consumer-"));
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const versions = metadata.devDependencies;
const dependencies = { "oss-kit": `file:${join(artifacts, "oss-kit-0.0.0.tgz")}` };
for (const name of ["next", "react", "react-dom", "typescript", "@types/node", "@types/react", "@types/react-dom", "drizzle-orm", "pg", "@types/pg", "tsx", "esbuild"]) dependencies[name] = versions[name];
await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "oss-kit-clean-consumer", version: "0.0.0", type: "module", private: true, dependencies }, null, 2));
await run("npm", ["install", "--no-audit", "--no-fund"], consumer);
// Copy examples FROM INSTALLED TARBALL, not the workspace. This verifies shipped files too.
await cp(join(consumer, "node_modules/oss-kit/examples/next"), consumer, { recursive: true });
await mkdir(join(consumer, "scripts"));
for (const name of ["packed-smoke.mjs", "mock-host.mjs", "mock-host.d.mts"]) await copyFile(join(root, "scripts", name), join(consumer, "scripts", name));
await writeFile(join(consumer, "scripts/postgres-smoke.ts"), (await readFile(join(root, "scripts/postgres-smoke.ts"), "utf8")).replaceAll("../examples/next/", "../"));
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["dom", "dom.iterable", "esnext"], module: "esnext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, plugins: [{ name: "next" }] }, include: ["**/*.ts", "**/*.tsx"], exclude: ["node_modules"] }, null, 2));
await mkdir(join(consumer, "doc-examples"));
for (const name of ["README.md", "AI-USAGE.md"]) {
  const doc = await readFile(join(consumer, "node_modules/oss-kit", name), "utf8"); let index = 0;
  for (const match of doc.matchAll(/```(ts|tsx|typescript)\n([\s\S]*?)```/g)) await writeFile(join(consumer, "doc-examples", `${name}-${++index}.${match[1] === "tsx" ? "tsx" : "ts"}`), `${match[2]}\nexport {};\n`);
}
await run("node", ["node_modules/typescript/bin/tsc", "--noEmit"], consumer);
await run("node", ["scripts/packed-smoke.mjs"], consumer);
await run("node", ["node_modules/next/dist/bin/next", "build", "--webpack"], consumer, { NEXT_TELEMETRY_DISABLED: "1" });
// Verify browser bundle contains only public client contracts/rules/React, never ali-oss or Node SDK.
const { build } = await import(join(consumer, "node_modules/esbuild/lib/main.js"));
await writeFile(join(consumer, "browser-entry.tsx"), 'export { StorageManager, StrategyEditor, UploadExample } from "oss-kit/react"; export { previewObjectKey } from "oss-kit/rules";');
const browser = await build({ absWorkingDir: consumer, entryPoints: ["browser-entry.tsx"], bundle: true, write: false, platform: "browser", metafile: true });
if (Object.keys(browser.metafile.inputs).some(path => /ali-oss|src\/server|dist\/server/.test(path))) throw new Error("Server SDK leaked into browser bundle");
await writeFile(join(consumer, "forbidden.ts"), 'import { createOssKit } from "oss-kit/server"; console.log(createOssKit);');
let blocked = false;
try {
  const forbidden = await build({ absWorkingDir: consumer, entryPoints: ["forbidden.ts"], bundle: true, write: false, platform: "browser", format: "iife", metafile: true, logLevel: "silent" });
  const paths = Object.keys(forbidden.metafile.inputs);
  if (!paths.some(path => path.endsWith("oss-kit/dist/browser-forbidden.js")) || paths.some(path => /ali-oss|oss-kit\/dist\/server\//.test(path))) throw new Error("Browser condition did not isolate the server API");
  // Some bundlers compile the guard successfully. Executing it must reject before any server code runs.
  try { runInNewContext(forbidden.outputFiles[0].text, { console: { log() {} } }, { timeout: 1000 }); }
  catch (error) { blocked = /server|Client Component|browser/.test(error.message); }
} catch (error) {
  if (error.message === "Browser condition did not isolate the server API") throw error;
  blocked = true;
}
if (!blocked) throw new Error("Browser server import was not rejected");
await withPostgres(connection => run("node", ["node_modules/tsx/dist/cli.mjs", "scripts/postgres-smoke.ts"], consumer, { OSS_KIT_TEST_POSTGRES: JSON.stringify(connection) }));
await writeFile(join(artifacts, "verification.json"), JSON.stringify({ consumer, verifiedAt: new Date().toISOString(), checks: ["real tgz install", "public types and documentation fences", "Next production build", "browser SDK isolation", "packed minimal Mock OSS flow", "real isolated PostgreSQL concurrency and file ownership"], ossCloud: "未实测：OSS 网络为 Mock；SDK V4 签名为真实 SDK 的本地计算；未验证真实上传、匿名访问或自定义域名绑定。" }, null, 2));
console.log(`Clean packed host retained at ${consumer}`);
