import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { createPackedConsumer, ensureBuiltPackage, packageRoot, runCommand, withPackedSmsKit } from "./helpers.js";

it("keeps safe exports browser-compatible while browser conditions poison every sensitive runtime entry", async () => {
  await ensureBuiltPackage();
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    devDependencies: Record<string, string>;
    exports: Record<string, Record<string, string>>;
  };

  expect(packageRoot).toContain("packages/sms-kit");
  expect(manifest.devDependencies).toMatchObject({
    next: "16.3.5",
    react: "19.3.0",
    "react-dom": "19.3.0",
  });
  for (const subpath of ["./application", "./security", "./postgres", "./aliyun", "./better-auth", "./next", "./testing"]) {
    expect(manifest.exports[subpath]?.browser).toBe("./dist/browser-forbidden.js");
  }
  for (const subpath of [".", "./core", "./ports", "./next/types"]) {
    expect(manifest.exports[subpath]?.browser).toBeUndefined();
  }

  await withPackedSmsKit(async (packed) => {
    const consumer = await createPackedConsumer(packed);
    const safeImports = await runCommand(process.execPath, ["--conditions=browser", "--input-type=module", "-e", `
      for (const specifier of ["sms-kit", "sms-kit/core", "sms-kit/ports", "sms-kit/next/types"]) {
        await import(specifier);
      }
      console.log("browser-safe imports ok");
    `], { cwd: consumer });
    expect(safeImports.exitCode, safeImports.output).toBe(0);
    expect(safeImports.output).toContain("browser-safe imports ok");

    const sensitiveImport = await runCommand(process.execPath, ["--conditions=browser", "--input-type=module", "-e", "await import('sms-kit/security')"], { cwd: consumer });
    expect(sensitiveImport.exitCode).not.toBe(0);
    expect(sensitiveImport.output).toMatch(/Server Component|Client Component/);
  });
}, 120_000);
