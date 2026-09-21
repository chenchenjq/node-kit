import { readFileSync } from "node:fs";
import { validateSchemaName } from "./schema.js";

/** Returns reviewable SQL; never connects, migrates, or creates a migration ledger. */
export function areaMigrationSql(schemaName = "public"): string {
  validateSchemaName(schemaName);
  const migration = readFileSync(new URL("../../migrations/0001-area-kit.sql", import.meta.url), "utf8");
  return migration.replaceAll('"public".', `"${schemaName}".`);
}
