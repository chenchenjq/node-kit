import type { PoolClient } from "pg";
import { validateSchemaName } from "./schema.js";
import { AreaKitError } from "../errors.js";

/** Transaction-scoped; the host must BEGIN before calling this function. */
export async function lockAreaLibrary(client: PoolClient, schemaName: string, mode: "shared" | "exclusive"): Promise<void> {
  validateSchemaName(schemaName);
  if (mode !== "shared" && mode !== "exclusive") throw new AreaKitError("INVALID_CONFIG");
  const statement = mode === "shared"
    ? "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))"
    : "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";
  await client.query(statement, [`area-kit:library:${schemaName}`]);
}
