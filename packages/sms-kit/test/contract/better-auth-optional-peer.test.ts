import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = process.cwd();
const repositoryRoot = join(packageRoot, "..", "..");

it("imports sms-kit/core in a fixture where Better Auth is physically absent", async () => {
  await run("npm", ["run", "build", "--workspace", "sms-kit"], { cwd: repositoryRoot });
  const fixture = await mkdtemp(join(tmpdir(), "sms-kit-core-without-better-auth-"));
  try {
    const modules = join(fixture, "node_modules");
    const fixturePackage = join(modules, "sms-kit");
    await mkdir(fixturePackage, { recursive: true });
    await cp(join(packageRoot, "dist", "core"), join(fixturePackage, "dist", "core"), { recursive: true });
    await writeFile(join(fixturePackage, "package.json"), JSON.stringify({
      name: "sms-kit", type: "module", exports: { "./core": { import: "./dist/core/index.js" } },
    }));
    await symlink(join(repositoryRoot, "node_modules", "libphonenumber-js"), join(modules, "libphonenumber-js"));

    await expect(lstat(join(modules, "better-auth"))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await run(process.execPath, ["--input-type=module", "-e", "await import('sms-kit/core'); console.log('core import ok')"], { cwd: fixture });
    expect(result.stdout).toContain("core import ok");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
