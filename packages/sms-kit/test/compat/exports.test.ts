import { expect, it } from "vitest";

import { createPackedConsumer, ensureBuiltPackage, hasInstalledPackage, runCommand, withPackedSmsKit } from "./helpers.js";

const publicSubpaths = [
  "sms-kit",
  "sms-kit/core",
  "sms-kit/application",
  "sms-kit/ports",
  "sms-kit/security",
  "sms-kit/postgres",
  "sms-kit/aliyun",
  "sms-kit/better-auth",
  "sms-kit/next/types",
  "sms-kit/testing",
] as const;

it("ships built public subpaths, keeps core optional-peer free, and poisons the Next runtime outside React Server", async () => {
  await ensureBuiltPackage();
  await withPackedSmsKit(async (packed) => {
    expect(packed.files).toContain("dist/next/index.js");
    expect(packed.files.every((path) => path === "AI_USAGE.md" || path === "README.md" || path === "package.json" || path.startsWith("dist/"))).toBe(true);
    expect(packed.files).not.toContain("src/index.ts");
    expect(packed.files).not.toContain("test/package-metadata.test.ts");

    const consumer = await createPackedConsumer(packed);
    expect(await hasInstalledPackage(packed.packageDirectory, "better-auth")).toBe(false);

    const imports = await runCommand(process.execPath, ["--input-type=module", "-e", `
      import { fileURLToPath } from "node:url";
      for (const specifier of ${JSON.stringify(publicSubpaths)}) {
        const resolved = fileURLToPath(await import.meta.resolve(specifier));
        if (!resolved.includes("/dist/") || resolved.includes("/src/")) {
          throw new Error(\`expected built output for \${specifier}, received \${resolved}\`);
        }
        await import(specifier);
      }
      console.log("packed public imports ok");
    `], { cwd: consumer });
    expect(imports.exitCode, imports.output).toBe(0);
    expect(imports.output).toContain("packed public imports ok");

    const coreWithoutBetterAuth = await runCommand(process.execPath, ["--input-type=module", "-e", "await import('sms-kit/core'); console.log('core import ok')"], { cwd: consumer });
    expect(coreWithoutBetterAuth.exitCode, coreWithoutBetterAuth.output).toBe(0);
    expect(coreWithoutBetterAuth.output).toContain("core import ok");

    const ordinarySecurityImport = await runCommand(process.execPath, ["--input-type=module", "-e", "await import('sms-kit/security'); console.log('security import ok')"], { cwd: consumer });
    expect(ordinarySecurityImport.exitCode, ordinarySecurityImport.output).toBe(0);
    expect(ordinarySecurityImport.output).toContain("security import ok");

    const poisonedNextRuntime = await runCommand(process.execPath, ["--input-type=module", "-e", "await import('sms-kit/next')"], { cwd: consumer });
    expect(poisonedNextRuntime.exitCode).not.toBe(0);
    expect(poisonedNextRuntime.output).toMatch(/Server Component|Client Component/);
  });
}, 120_000);
