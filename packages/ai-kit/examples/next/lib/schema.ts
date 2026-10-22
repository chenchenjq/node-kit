import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { GenerationParameters, Protocol } from "ai-kit";
/** Call from your host schema; generate migrations through your existing migration workflow. */
export function createAiTables(prefix = "ai_kit") {
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(prefix))
    throw new Error("Invalid table prefix");
  const connections = pgTable(
    `${prefix}_connections`,
    {
      scope: text("scope").notNull(),
      id: text("id").notNull(),
      name: text("name").notNull(),
      providerCode: text("provider_code").notNull(),
      protocol: text("protocol").$type<Protocol>().notNull(),
      baseURL: text("base_url").notNull(),
      credentialEnvelope: text("credential_envelope").notNull(),
      enabled: boolean("enabled").notNull(),
      revision: integer("revision").notNull(),
      testedRevision: integer("tested_revision"),
    },
    (t) => [
      primaryKey({ columns: [t.scope, t.id] }),
      check(`${prefix}_connection_revision`, sql`${t.revision}>0`),
    ],
  );
  const plans = pgTable(
    `${prefix}_plans`,
    {
      scope: text("scope").notNull(),
      id: text("id").notNull(),
      code: text("code").notNull(),
      name: text("name").notNull(),
      connectionId: text("connection_id").notNull(),
      modelId: text("model_id").notNull(),
      enabled: boolean("enabled").notNull(),
      isDefault: boolean("is_default").notNull(),
      systemPrompt: text("system_prompt"),
      parameters: jsonb("parameters").$type<GenerationParameters>().notNull(),
      revision: integer("revision").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.scope, t.code] }),
      uniqueIndex(`${prefix}_plan_id`).on(t.scope, t.id),
      uniqueIndex(`${prefix}_one_enabled_default`)
        .on(t.scope)
        .where(sql`${t.enabled} AND ${t.isDefault}`),
      check(
        `${prefix}_default_enabled`,
        sql`NOT ${t.isDefault} OR ${t.enabled}`,
      ),
      check(`${prefix}_plan_revision`, sql`${t.revision}>0`),
      foreignKey({
        columns: [t.scope, t.connectionId],
        foreignColumns: [connections.scope, connections.id],
      }).onDelete("restrict"),
    ],
  );
  // Fallback ONLY when your host has no dictionary module. Otherwise inject that module's DictionaryPort.
  const dictionaryTypes = pgTable(
    `${prefix}_dictionary_types`,
    {
      scope: text("scope").notNull(),
      code: text("code").notNull(),
      name: text("name").notNull(),
    },
    (t) => [primaryKey({ columns: [t.scope, t.code] })],
  );
  const dictionaryItems = pgTable(
    `${prefix}_dictionary_items`,
    {
      scope: text("scope").notNull(),
      type: text("type").notNull(),
      code: text("code").notNull(),
      name: text("name").notNull(),
      sort: integer("sort").notNull(),
      enabled: boolean("enabled").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.scope, t.type, t.code] }),
      foreignKey({
        columns: [t.scope, t.type],
        foreignColumns: [dictionaryTypes.scope, dictionaryTypes.code],
      }).onDelete("restrict"),
    ],
  );
  return { connections, plans, dictionaryTypes, dictionaryItems };
}
export type AiTables = ReturnType<typeof createAiTables>;
