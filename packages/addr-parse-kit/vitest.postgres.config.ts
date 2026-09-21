import { defineConfig } from "vitest/config";
import { isolatedPostgresConfig } from "./test/postgres/config.js";

isolatedPostgresConfig();
export default defineConfig({
  test: {
    include: ["test/postgres/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
