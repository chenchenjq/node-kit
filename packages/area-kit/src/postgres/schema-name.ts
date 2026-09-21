import { AreaKitError } from "../errors.js";

/** Validate configuration without loading the optional database dependencies. */
export function validateSchemaName(schemaName: string): void {
  if (typeof schemaName !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new AreaKitError("INVALID_CONFIG");
  }
}
