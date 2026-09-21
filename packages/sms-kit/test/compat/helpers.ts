import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const repositoryRoot = join(packageRoot, "..", "..");

export type CommandResult = Readonly<{
  exitCode: number;
  output: string;
}>;

export type PackedSmsKit = Readonly<{
  archivePath: string;
  directory: string;
  packageDirectory: string;
  files: readonly string[];
}>;

let buildPromise: Promise<void> | undefined;

export async function ensureBuiltPackage(): Promise<void> {
  buildPromise ??= (async () => {
    const build = await runCommand("npm", ["run", "build", "--workspace", "sms-kit"], { cwd: repositoryRoot });
    if (build.exitCode !== 0) throw new Error(`sms-kit build failed before compatibility checks:\n${build.output}`);
  })();
  return buildPromise;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv }>,
): Promise<CommandResult> {
  const commandOptions = { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 };
  try {
    const result = options.env === undefined
      ? await run(command, args, commandOptions)
      : await run(command, args, { ...commandOptions, env: options.env });
    return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error: unknown) {
    const failed = error as Readonly<{ code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }>;
    const exitCode = typeof failed.code === "number" ? failed.code : 1;
    const stdout = typeof failed.stdout === "string" ? failed.stdout : "";
    const stderr = typeof failed.stderr === "string" ? failed.stderr : "";
    const message = typeof failed.message === "string" ? failed.message : "";
    return { exitCode, output: `${stdout}${stderr}${message}` };
  }
}

export async function withPackedSmsKit<T>(work: (packed: PackedSmsKit) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "sms-kit-compat-package-"));
  try {
    const packed = await runCommand("npm", ["pack", "--json", "--pack-destination", directory], { cwd: packageRoot });
    if (packed.exitCode !== 0) throw new Error(`npm pack failed:\n${packed.output}`);

    const result = JSON.parse(packed.output) as readonly Readonly<{
      filename: string;
      files: readonly Readonly<{ path: string }>[];
    }>[];
    const archive = result[0];
    if (archive === undefined) throw new Error("npm pack did not produce an archive");

    const extractionDirectory = join(directory, "extracted");
    await mkdir(extractionDirectory, { recursive: true });
    const extracted = await runCommand("tar", ["-xzf", join(directory, archive.filename), "-C", extractionDirectory], { cwd: directory });
    if (extracted.exitCode !== 0) throw new Error(`could not extract packed sms-kit:\n${extracted.output}`);

    return await work({
      archivePath: join(directory, archive.filename),
      directory,
      packageDirectory: join(extractionDirectory, "package"),
      files: archive.files.map((file) => file.path),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const runtimeDependencies = [
  ["@alicloud", repositoryRoot],
  ["libphonenumber-js", repositoryRoot],
  ["server-only", repositoryRoot],
  ["vitest", packageRoot],
  ["zod", repositoryRoot],
] as const;

export async function createPackedConsumer(packed: PackedSmsKit): Promise<string> {
  const consumer = join(packed.directory, "consumer");
  const modules = join(consumer, "node_modules");
  const packageModules = join(packed.packageDirectory, "node_modules");
  await mkdir(modules, { recursive: true });
  await symlink(packed.packageDirectory, join(modules, "sms-kit"), "dir");

  for (const [dependency, dependencyRoot] of runtimeDependencies) {
    const destination = join(packageModules, dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(dependencyRoot, "node_modules", dependency), destination, "dir");
  }

  return consumer;
}

export async function hasInstalledPackage(consumer: string, packageName: string): Promise<boolean> {
  try {
    await lstat(join(consumer, "node_modules", packageName));
    return true;
  } catch {
    return false;
  }
}
