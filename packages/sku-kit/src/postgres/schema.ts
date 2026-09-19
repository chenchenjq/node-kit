import { sql } from "drizzle-orm";
import { bigint, check, integer, jsonb, numeric, pgSchema, pgTable, smallint, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
import type { PgTableFn } from "drizzle-orm/pg-core";

const schemaNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const validateSkuSchemaName = (schemaName: string): void => {
  if (!schemaNamePattern.test(schemaName)) throw new Error("无效的 PostgreSQL schema 名称");
};

export const createSkuTables = (schemaName = "public") => {
  validateSkuSchemaName(schemaName);
  const table: PgTableFn<string | undefined> = schemaName === "public" ? pgTable : pgSchema(schemaName).table;
  const scopeConfig = table("sku_scope_config", {
    scopeKey: varchar("scope_key", { length: 128 }).primaryKey(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    inventoryAuthorityKind: text("inventory_authority_kind").notNull(),
    authorityKey: text("authority_key").notNull(),
    version: bigint("version", { mode: "bigint" }).notNull().default(1n),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }, (t) => [check("sku_scope_config_currency", sql`${t.currency} = 'CNY'`)]);
  const product = table("sku_product_config", {
    scopeKey: varchar("scope_key", { length: 128 }).notNull(),
    spuId: varchar("spu_id", { length: 128 }).notNull(),
    registeredSpuCode: varchar("registered_spu_code", { length: 126 }).notNull(),
    structureVersion: bigint("structure_version", { mode: "bigint" }).notNull().default(0n),
    nextSequence: smallint("next_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  }, (t) => [unique("sku_product_scope_spu").on(t.scopeKey, t.spuId), unique("sku_product_scope_code").on(t.scopeKey, t.registeredSpuCode), check("sku_product_sequence", sql`${t.nextSequence} BETWEEN 0 AND 100`)]);
  const dimension = table("sku_dimension", {
    id: uuid("id").primaryKey().defaultRandom(), scopeKey: varchar("scope_key", { length: 128 }).notNull(), spuId: varchar("spu_id", { length: 128 }).notNull(), label: varchar("label", { length: 64 }).notNull(), normalizedLabel: varchar("normalized_label", { length: 64 }).notNull(), sort: integer("sort").notNull().default(0), archivedAt: timestamp("archived_at", { withTimezone: true }),
  });
  const value = table("sku_value", {
    id: uuid("id").primaryKey().defaultRandom(), dimensionId: uuid("dimension_id").notNull(), scopeKey: varchar("scope_key", { length: 128 }).notNull(), spuId: varchar("spu_id", { length: 128 }).notNull(), label: varchar("label", { length: 128 }).notNull(), normalizedLabel: varchar("normalized_label", { length: 128 }).notNull(), sort: integer("sort").notNull().default(0), archivedAt: timestamp("archived_at", { withTimezone: true }),
  });
  const sku = table("sku_sku", {
    id: uuid("id").primaryKey().defaultRandom(), scopeKey: varchar("scope_key", { length: 128 }).notNull(), spuId: varchar("spu_id", { length: 128 }).notNull(), skuCode: varchar("sku_code", { length: 128 }).notNull(), sequence: smallint("sequence").notNull(), combinationKey: text("combination_key").notNull(), suggestedRetailPrice: numeric("suggested_retail_price", { precision: 18, scale: 2 }), supplyPrice: numeric("supply_price", { precision: 18, scale: 2 }), imageAdapter: varchar("image_adapter", { length: 64 }), imageValue: text("image_value"), status: text("status").notNull().default("disabled"), configVersion: bigint("config_version", { mode: "bigint" }).notNull().default(1n), archivedAt: timestamp("archived_at", { withTimezone: true }),
  }, (t) => [unique("sku_sku_scope_code").on(t.scopeKey, t.skuCode), unique("sku_sku_spu_sequence").on(t.scopeKey, t.spuId, t.sequence), unique("sku_sku_spu_combination").on(t.scopeKey, t.spuId, t.combinationKey), check("sku_sku_sequence", sql`${t.sequence} BETWEEN 0 AND 99`), check("sku_sku_status", sql`${t.status} IN ('disabled', 'enabled', 'archived')`)]);
  const selection = table("sku_selection", { skuId: uuid("sku_id").notNull(), scopeKey: varchar("scope_key", { length: 128 }).notNull(), spuId: varchar("spu_id", { length: 128 }).notNull(), dimensionId: uuid("dimension_id").notNull(), valueId: uuid("value_id").notNull() }, (t) => [unique("sku_selection_pair").on(t.skuId, t.dimensionId)]);
  const inventory = table("sku_local_inventory", { skuId: uuid("sku_id").primaryKey(), quantity: integer("quantity").notNull().default(0), version: bigint("version", { mode: "bigint" }).notNull().default(1n), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow() }, (t) => [check("sku_inventory_nonnegative", sql`${t.quantity} >= 0`)]);
  const receipt = table("sku_command_receipt", { scopeKey: varchar("scope_key", { length: 128 }).notNull(), spuId: varchar("spu_id", { length: 128 }).notNull(), commandId: varchar("command_id", { length: 128 }).notNull(), commandType: varchar("command_type", { length: 64 }).notNull(), fingerprint: text("fingerprint").notNull(), result: jsonb("result").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull() }, (t) => [unique("sku_receipt_command").on(t.scopeKey, t.spuId, t.commandId)]);
  return { scopeConfig, product, dimension, value, sku, selection, inventory, receipt };
};

export type SkuTables = ReturnType<typeof createSkuTables>;
