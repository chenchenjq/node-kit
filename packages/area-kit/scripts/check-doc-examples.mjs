import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const documentNames = ["README.md", "DATABASE.md", "DATA-SOURCE.md", "AI-USAGE.md"];

function usage() {
  throw new Error("Usage: node scripts/check-doc-examples.mjs --consumer-dir <absolute-dir>");
}

function consumerDirectoryFromArguments(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--consumer-dir" || !arguments_[1]) usage();
  const directory = arguments_[1];
  if (!directory.startsWith("/")) usage();
  return resolve(directory);
}

async function requireFile(path) {
  await access(path);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Expected file: ${path}`);
}

async function main() {
  const consumerDirectory = consumerDirectoryFromArguments(process.argv.slice(2));
  const packageDirectory = join(consumerDirectory, "node_modules", "area-kit");
  const typescript = join(consumerDirectory, "node_modules", "typescript", "bin", "tsc");
  await requireFile(join(packageDirectory, "package.json"));
  await requireFile(typescript);

  const examplesDirectory = join(consumerDirectory, "doc-examples");
  await rm(examplesDirectory, { recursive: true, force: true });
  await mkdir(examplesDirectory, { recursive: true });
  const files = [];
  for (const documentName of documentNames) {
    const document = await readFile(join(packageDirectory, documentName), "utf8");
    const blocks = [...document.matchAll(/```(ts|tsx|typescript)\n([\s\S]*?)```/g)];
    if (!blocks.length) throw new Error(`${documentName} has no TypeScript example`);
    for (const [index, block] of blocks.entries()) {
      const extension = block[1] === "tsx" ? "tsx" : "ts";
      const filename = join(examplesDirectory, `${documentName.replace(/\.md$/, "")}-${index}.${extension}`);
      await writeFile(filename, `${block[2]}\nexport {};\n`);
      files.push(filename);
    }
  }

  await execute(process.execPath, [typescript, "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--jsx", "react-jsx", ...files], {
    cwd: consumerDirectory,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_PATH")),
  });
  process.stdout.write(`Compiled ${files.length} documentation examples from installed area-kit.\n`);
}

await main();
