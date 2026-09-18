/** Keep normal process settings, but never inherit PostgreSQL connection/startup settings. */
export function postgresTestEnvironment(config, ambient = process.env) {
  const environment = Object.fromEntries(Object.entries(ambient).filter(([key]) => {
    const name = key.toUpperCase();
    return !name.startsWith("PG") && name !== "DATABASE_URL" &&
      name !== "AREA_KIT_DATABASE_URL" && name !== "AREA_KIT_TEST_POSTGRES";
  }));
  return { ...environment, AREA_KIT_TEST_POSTGRES: JSON.stringify(config) };
}
