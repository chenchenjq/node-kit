import { afterEach, expect, it, vi } from "vitest";
import { isolatedPostgresConfig } from "./postgres/config.js";

afterEach(() => vi.unstubAllEnvs());

it("refuses missing or non-ephemeral test configuration without falling back to DATABASE_URL", () => {
  vi.stubEnv("DATABASE_URL", "postgres://forbidden.invalid/production");
  vi.stubEnv("AREA_KIT_TEST_POSTGRES", undefined);
  expect(() => isolatedPostgresConfig()).toThrow(/isolated container required/);
  const valid = { host: "127.0.0.1", port: 54321, user: "isolated-test-only", password: "isolated-test-only",
    database: "area_kit_ephemeral_test", containerId: "a".repeat(64) };
  for (const patch of [{database: "production"}, {user: "postgres"}, {password: "other"},
    {port: 0}, {port: 65536}, {port: 1.5}, {containerId: ""}, {host: ""}]) {
    vi.stubEnv("AREA_KIT_TEST_POSTGRES", JSON.stringify({ ...valid, ...patch }));
    expect(() => isolatedPostgresConfig()).toThrow(/non-ephemeral/);
  }
  vi.stubEnv("AREA_KIT_TEST_POSTGRES", JSON.stringify({ ...valid, connectionString: "postgres://forbidden.invalid/production" }));
  expect(isolatedPostgresConfig()).toEqual({ host: "127.0.0.1", port: 54321, user: "isolated-test-only",
    password: "isolated-test-only", database: "area_kit_ephemeral_test", ssl: false, connectionTimeoutMillis: 5000,
    application_name: "area-kit-isolated-test" });
});
