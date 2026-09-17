import { defineConfig } from "vitest/config";
import { isolatedPostgresConfig } from "./test/postgres/config.js";

isolatedPostgresConfig();
export default defineConfig({
  test: {
    include: ["test/postgres/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
