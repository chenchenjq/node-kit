#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(scriptDirectory, "../dist/cli.js"), ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.once("error", () => {
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.exitCode = signal === null ? (code ?? 1) : 1;
});
