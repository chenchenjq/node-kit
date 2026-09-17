/** Never fall back to DATABASE_URL or the ambient PG* connection settings. */
export function isolatedPostgresConfig() {
  const raw = process.env.AREA_KIT_TEST_POSTGRES;
  if (!raw) throw new Error("Run PostgreSQL tests through npm run test:postgres (isolated container required)");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("Invalid isolated PostgreSQL configuration");
  const config = value as Record<string, unknown>;
  if (config.database !== "area_kit_ephemeral_test" ||
      config.user !== "isolated-test-only" || config.password !== "isolated-test-only" ||
      typeof config.host !== "string" || !config.host ||
      typeof config.port !== "number" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      typeof config.containerId !== "string" || !/^[a-f0-9]{64}$/.test(config.containerId)) {
    throw new Error("Refusing non-ephemeral PostgreSQL configuration");
  }
  return {
    host: config.host, port: config.port,
    user: "isolated-test-only", password: "isolated-test-only", database: "area_kit_ephemeral_test",
    ssl: false as const, connectionTimeoutMillis: 5_000, application_name: "area-kit-isolated-test",
  };
}
