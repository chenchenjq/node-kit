const EPHEMERAL = {
  database: "area_parse_kit_ephemeral_test",
  user: "isolated-test-only",
  password: "isolated-test-only",
} as const;

/** 只接受一次性容器传来的连接参数；绝不回退到 DATABASE_URL 或环境里的 PG* 配置。 */
export function isolatedPostgresConfig() {
  const raw = process.env.ADDR_PARSE_KIT_TEST_POSTGRES;
  if (!raw) throw new Error("PostgreSQL 集成测试必须通过 npm run test:integration 启动（需要一次性隔离容器）");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) throw new Error("隔离 PostgreSQL 配置格式非法");
  const config = value as Record<string, unknown>;
  if (
    config.database !== EPHEMERAL.database ||
    config.user !== EPHEMERAL.user ||
    config.password !== EPHEMERAL.password ||
    typeof config.host !== "string" ||
    !config.host ||
    typeof config.port !== "number" ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.containerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(config.containerId)
  ) {
    throw new Error("拒绝使用非一次性 PostgreSQL 连接");
  }
  return {
    host: config.host,
    port: config.port,
    ...EPHEMERAL,
    ssl: false as const,
    connectionTimeoutMillis: 5_000,
    application_name: "addr-parse-kit-isolated-test",
  };
}
