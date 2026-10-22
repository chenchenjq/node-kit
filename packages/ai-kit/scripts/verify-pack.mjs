import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./run.mjs";
const root = fileURLToPath(new URL("../", import.meta.url)),
  artifacts = resolve(root, "artifacts");
await mkdir(artifacts, { recursive: true });
await run("npm", ["run", "build"], root);
await run("npm", ["pack", "--pack-destination", artifacts], root);
const consumer = await mkdtemp(join(tmpdir(), "ai-kit-consumer-")),
  meta = JSON.parse(await readFile(join(root, "package.json"), "utf8")),
  dependencies = { "ai-kit": `file:${join(artifacts, "ai-kit-0.0.0.tgz")}` };
for (const name of [
  "next",
  "react",
  "react-dom",
  "typescript",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "drizzle-orm",
  "pg",
  "@types/pg",
  "tsx",
  "esbuild",
])
  dependencies[name] = meta.devDependencies[name];
dependencies.zod = meta.dependencies.zod;
await writeFile(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "ai-kit-clean-consumer",
      private: true,
      type: "module",
      dependencies,
    },
    null,
    2,
  ),
);
await run("npm", ["install", "--no-audit", "--no-fund"], consumer);
await cp(join(consumer, "node_modules/ai-kit/examples/next"), consumer, {
  recursive: true,
});
await mkdir(join(consumer, "scripts"));
await copyFile(
  join(root, "scripts/packed-smoke.mjs"),
  join(consumer, "scripts/packed-smoke.mjs"),
);
await writeFile(
  join(consumer, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        plugins: [{ name: "next" }],
      },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["node_modules"],
    },
    null,
    2,
  ),
);
await mkdir(join(consumer, "doc-examples"));
for (const name of ["README.md", "AI-USAGE.md"]) {
  const doc = await readFile(
    join(consumer, "node_modules/ai-kit", name),
    "utf8",
  );
  let i = 0;
  for (const match of doc.matchAll(/```(ts|tsx|typescript)\n([\s\S]*?)```/g))
    await writeFile(
      join(
        consumer,
        "doc-examples",
        `${name}-${++i}.${match[1] === "tsx" ? "tsx" : "ts"}`,
      ),
      match[2] + "\nexport {};\n",
    );
}
await run("node", ["node_modules/typescript/bin/tsc", "--noEmit"], consumer);
await run("node", ["scripts/packed-smoke.mjs"], consumer);
await run(
  "node",
  ["node_modules/next/dist/bin/next", "build", "--webpack"],
  consumer,
  { NEXT_TELEMETRY_DISABLED: "1" },
);
const { build } = await import(
  join(consumer, "node_modules/esbuild/lib/main.js")
);
await writeFile(
  join(consumer, "browser-entry.tsx"),
  'export { AiManager, ConnectionEditor, PlanEditor, TextGenerationExample } from "ai-kit/react"; export { modelPresets } from "ai-kit/catalog";',
);
const browser = await build({
  absWorkingDir: consumer,
  entryPoints: ["browser-entry.tsx"],
  bundle: true,
  write: false,
  platform: "browser",
  metafile: true,
});
if (
  Object.keys(browser.metafile.inputs).some((p) =>
    /(@ai-sdk|\/ai\/dist|ai-kit\/dist\/server|undici|ipaddr)/.test(p),
  )
)
  throw new Error("Server SDK leaked into browser");
await writeFile(
  join(consumer, "forbidden.ts"),
  'import { createAiKit } from "ai-kit/server"; console.log(createAiKit);',
);
let blocked = false;
try {
  await build({
    absWorkingDir: consumer,
    entryPoints: ["forbidden.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    logLevel: "silent",
  });
} catch {
  blocked = true;
}
if (!blocked) throw new Error("Browser import did not reject server entry");
const goodNextConfig = await readFile(
    join(consumer, "next.config.mjs"),
    "utf8",
  ),
  goodNextEnv = await readFile(join(consumer, "next-env.d.ts"), "utf8");
await writeFile(
  join(consumer, "next.config.mjs"),
  "export default {distDir:'.next-negative',experimental:{cpus:2}};",
);
// Next React Server condition must enforce server-only, even if a Client Component imports the sensitive entry.
await mkdir(join(consumer, "app/forbidden"));
await writeFile(
  join(consumer, "app/forbidden/page.tsx"),
  '"use client"; import { createAiKit } from "ai-kit/server"; export default function Page(){return <p>{String(createAiKit)}</p>}',
);
let nextBlocked = false;
try {
  await run(
    "node",
    ["node_modules/next/dist/bin/next", "build", "--webpack"],
    consumer,
    { NEXT_TELEMETRY_DISABLED: "1" },
  );
} catch {
  nextBlocked = true;
}
if (!nextBlocked)
  throw new Error("Next Client Component imported sensitive server entry");
await rm(join(consumer, "app/forbidden"), { recursive: true, force: true });
await rm(join(consumer, "forbidden.ts"));
await writeFile(join(consumer, "next.config.mjs"), goodNextConfig);
await writeFile(join(consumer, "next-env.d.ts"), goodNextEnv);
await rm(join(consumer, ".next-negative"), { recursive: true, force: true });
await writeFile(
  join(artifacts, "verification.json"),
  JSON.stringify(
    {
      consumer,
      verifiedAt: new Date().toISOString(),
      checks: [
        "real tgz external install",
        "export and documentation types",
        "nine installed Mock providers",
        "installed stream and authorization",
        "Next production build",
        "browser SDK isolation",
        "Next rejects server import",
      ],
      cloud:
        "Nine providers not live-tested: no user-supplied credentials; Mock is not a cloud test.",
    },
    null,
    2,
  ),
);
console.log(`Clean consumer retained at ${consumer}`);
