import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sms-kit package metadata", () => {
  it("cannot be published and declares supported exports", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=20");
    expect(Object.keys(pkg.exports)).toEqual([
      ".", "./core", "./application", "./ports", "./security", "./postgres",
      "./aliyun", "./better-auth", "./next", "./next/types", "./testing",
    ]);
    await Promise.all([
      "index", "core/index", "application/index", "ports/index", "security/index",
      "postgres/index", "aliyun/index", "better-auth/index", "next/index",
      "next/types/index", "testing/index",
    ].map((entry) => access(new URL(`../src/${entry}.ts`, import.meta.url))));
    expect(pkg.exports["./security"].browser).toBe("./dist/browser-forbidden.js");
    expect(pkg.exports["./core"].browser).toBeUndefined();
  });

  it("keeps live suites out of default test scripts and selects them only explicitly", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.test).toContain("--exclude 'test/live/**'");
    expect(pkg.scripts["test:unit"]).toContain("--exclude 'test/live/**'");
    expect(pkg.scripts["test:live"]).toBe("vitest run test/live");
    expect(pkg.scripts["test:live:connection"]).toBe("vitest run test/live/aliyun.connection.live.test.ts");
  });
});
