#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

console.log("[verify-pack] Packing auth-kit...");
const packOutput = execFileSync("npm", ["pack", "--json"], {
  cwd: root,
  encoding: "utf8",
});
const packInfo = JSON.parse(packOutput)[0];
const tarballPath = join(root, packInfo.filename);

console.log(`[verify-pack] Generated ${tarballPath} (${packInfo.size} bytes)`);

// Verify file list in tarball
const files = new Set(packInfo.files.map((f) => f.path));
assert(files.has("dist/server/index.js"), "dist/server/index.js must be in pack");
assert(files.has("dist/server/index.d.ts"), "dist/server/index.d.ts must be in pack");
assert(files.has("dist/server/schema.js"), "dist/server/schema.js must be in pack");
assert(files.has("dist/react/index.js"), "dist/react/index.js must be in pack");
assert(files.has("dist/types.d.ts"), "dist/types.d.ts must be in pack");
assert(files.has("dist/browser-forbidden.js"), "dist/browser-forbidden.js must be in pack");
assert(files.has("package.json"), "package.json must be in pack");
assert(files.has("README.md"), "README.md must be in pack");
assert(files.has("AI-USAGE.md"), "AI-USAGE.md must be in pack");

// Create temporary directory to verify extraction and imports
const tempDir = await mkdtemp(join(tmpdir(), "auth-kit-pack-verify-"));
try {
  console.log(`[verify-pack] Extracting into temporary environment ${tempDir}...`);
  execFileSync("tar", ["-xzf", tarballPath, "-C", tempDir]);

  const { symlink } = await import("node:fs/promises");
  await symlink(join(root, "../../node_modules"), join(tempDir, "node_modules"));

  const packageDir = join(tempDir, "package");
  const serverUrl = pathToFileURL(join(packageDir, "dist/server/index.js")).href;
  const schemaUrl = pathToFileURL(join(packageDir, "dist/server/schema.js")).href;
  const reactUrl = pathToFileURL(join(packageDir, "dist/react/index.js")).href;
  const forbiddenUrl = pathToFileURL(join(packageDir, "dist/browser-forbidden.js")).href;

  console.log("[verify-pack] Verifying server exports...");
  const server = await import(serverUrl);
  assert(typeof server.migrateAuthPhoneStorage === "function", "phone migration must be exported");
  assert(typeof server.createAuthKit === "function", "createAuthKit must be exported");
  assert(typeof server.hashPassword === "function", "hashPassword must be exported");
  assert(typeof server.verifyPassword === "function", "verifyPassword must be exported");
  assert(typeof server.validatePassword === "function", "validatePassword must be exported");
  assert(typeof server.AuthKitError === "function", "AuthKitError must be exported");

  console.log("[verify-pack] Verifying schema exports...");
  const schema = await import(schemaUrl);
  assert(typeof schema.createAuthSchema === "function", "createAuthSchema must be exported");
  assert(typeof schema.authSchemaSql === "function", "authSchemaSql must be exported");

  console.log("[verify-pack] Verifying react exports...");
  const react = await import(reactUrl);
  assert(typeof react.createAuthClient === "function", "createAuthClient must be exported");
  assert(typeof react.AuthClientError === "function", "AuthClientError must be exported");
  assert(typeof react.AuthForms === "function", "AuthForms must be exported");

  console.log("[verify-pack] Verifying browser-forbidden barrier...");
  try {
    await import(forbiddenUrl);
    assert.fail("browser-forbidden should have thrown");
  } catch (err) {
    assert(
      err instanceof Error,
      "browser-forbidden must throw when evaluated"
    );
  }

  console.log("[verify-pack] All pack checks passed successfully.");
} finally {
  await rm(tarballPath, { force: true });
  await rm(tempDir, { recursive: true, force: true });
}
