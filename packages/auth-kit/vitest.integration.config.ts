import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["test/integration/**/*.test.ts"], fileParallelism: false,
  hookTimeout: 300_000, testTimeout: 120_000,
} });
