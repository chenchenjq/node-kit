import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import type { FileReference, Strategy } from "oss-kit";
/** Call inside the host's schema module; names may be customized before generating its own migration. */
export function createOssTables(prefix = "oss_kit") {
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(prefix)) throw new Error("Invalid table prefix");
  const storage = pgTable(`${prefix}_storage`, {
    scope: text("scope").notNull(), id: text("id").notNull(), name: text("name").notNull(),
    region: text("region").notNull(), bucket: text("bucket").notNull(), endpoint: text("endpoint").notNull(),
    access: text("access").$type<"private" | "public">().notNull(), publicDomain: text("public_domain"),
    credentialEnvelope: text("credential_envelope").notNull(), enabled: boolean("enabled").notNull(),
    isDefault: boolean("is_default").notNull(), used: boolean("used").notNull(), revision: integer("revision").notNull(),
  }, t => [primaryKey({ columns: [t.scope, t.id] }), uniqueIndex(`${prefix}_one_default`).on(t.scope).where(sql`${t.enabled} AND ${t.isDefault}`), check(`${prefix}_default_enabled`, sql`NOT ${t.isDefault} OR ${t.enabled}`)]);
  const strategies = pgTable(`${prefix}_strategies`, {
    scope: text("scope").notNull(), code: text("code").notNull(), payload: jsonb("payload").$type<Strategy>().notNull(),
  }, t => [primaryKey({ columns: [t.scope, t.code] })]);
  // These business records belong to the HOST. Replace the repository with your own file/attachment table.
  const files = pgTable(`${prefix}_files`, {
    id: text("id").primaryKey(), scope: text("scope").notNull(), ownerId: text("owner_id").notNull(), reference: jsonb("reference").$type<FileReference>().notNull(),
  });
  return { storage, strategies, files };
}
export type OssTables = ReturnType<typeof createOssTables>;
