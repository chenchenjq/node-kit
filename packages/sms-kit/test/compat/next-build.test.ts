import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ensureBuiltPackage, packageRoot, runCommand, withPackedSmsKit } from "./helpers.js";

const fixtureRoot = join(packageRoot, "test", "fixtures", "next-host");
const fixtureRoutes = ["server", "type-only", "forbidden"] as const;

async function runNextFixture(routes: readonly (typeof fixtureRoutes)[number][], packedArchive: string) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sms-kit-next-host-"));
  const host = join(temporaryRoot, "host");
  try {
    await cp(fixtureRoot, host, { recursive: true });
    for (const route of fixtureRoutes) {
      if (!routes.includes(route)) await rm(join(host, "app", route), { recursive: true, force: true });
    }

    const fixtureDependencies = await runCommand("npm", [
      "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
    ], { cwd: host, env: { ...process.env, CI: "1" } });
    if (fixtureDependencies.exitCode !== 0) return fixtureDependencies;

    const unpackedPackage = await runCommand("tar", ["-xzf", packedArchive, "-C", join(host, "node_modules")], { cwd: host });
    if (unpackedPackage.exitCode !== 0) return unpackedPackage;
    await rename(join(host, "node_modules", "package"), join(host, "node_modules", "sms-kit"));

    return await runCommand(join(host, "node_modules", ".bin", "next"), ["build"], {
      cwd: host,
      env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

it("builds server and type-only consumers but rejects a sensitive Client Component import", async () => {
  await ensureBuiltPackage();
  await withPackedSmsKit(async (packed) => {
    const allowed = await runNextFixture(["server", "type-only"], packed.archivePath);
    expect(allowed.exitCode, allowed.output).toBe(0);

    const forbidden = await runNextFixture(["forbidden"], packed.archivePath);
    expect(forbidden.exitCode).not.toBe(0);
    expect(forbidden.output).toMatch(/server-only|Server Component|Client Component/i);
  });
}, 180_000);
