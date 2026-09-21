import { validateSkuSchemaName } from "./schema.js";
const quoteSchema = (schemaName) => `"${schemaName}"`;
const bigint = (value) => BigInt(String(value));
const nullable = (value) => value === null || value === undefined ? null : String(value);
const tableNames = (schemaName) => {
    const schema = quoteSchema(schemaName);
    return {
        scope: `${schema}.sku_scope_config`,
        product: `${schema}.sku_product_config`, dimension: `${schema}.sku_dimension`, value: `${schema}.sku_value`,
        sku: `${schema}.sku_sku`, selection: `${schema}.sku_selection`, inventory: `${schema}.sku_local_inventory`,
        receipt: `${schema}.sku_command_receipt`,
    };
};
const readDocument = async (client, schemaName, scopeKey, spuId, lock = false) => {
    const t = tableNames(schemaName);
    const product = await client.query(`SELECT scope_key, spu_id, registered_spu_code, structure_version, next_sequence FROM ${t.product} WHERE scope_key = $1 AND spu_id = $2${lock ? " FOR UPDATE" : ""}`, [scopeKey, spuId]);
    const root = product.rows[0];
    if (!root)
        return null;
    const [dimensions, values, skus, selections, inventories, receipts] = await Promise.all([
        client.query(`SELECT id, label, normalized_label, sort, archived_at FROM ${t.dimension} WHERE scope_key = $1 AND spu_id = $2 ORDER BY sort, id`, [scopeKey, spuId]),
        client.query(`SELECT id, dimension_id, label, normalized_label, sort, archived_at FROM ${t.value} WHERE scope_key = $1 AND spu_id = $2 ORDER BY sort, id`, [scopeKey, spuId]),
        client.query(`SELECT id, sku_code, sequence, combination_key, suggested_retail_price, supply_price, image_adapter, image_value, status, config_version, archived_at FROM ${t.sku} WHERE scope_key = $1 AND spu_id = $2 ORDER BY sequence`, [scopeKey, spuId]),
        client.query(`SELECT s.sku_id, s.dimension_id, s.value_id FROM ${t.selection} s JOIN ${t.sku} k ON k.id = s.sku_id WHERE k.scope_key = $1 AND k.spu_id = $2`, [scopeKey, spuId]),
        client.query(`SELECT i.sku_id, i.quantity, i.version FROM ${t.inventory} i JOIN ${t.sku} k ON k.id = i.sku_id WHERE k.scope_key = $1 AND k.spu_id = $2`, [scopeKey, spuId]),
        client.query(`SELECT command_id, fingerprint, result FROM ${t.receipt} WHERE scope_key = $1 AND spu_id = $2 AND expires_at > now()`, [scopeKey, spuId]),
    ]);
    const valuesByDimension = new Map();
    for (const row of values.rows) {
        const key = String(row.dimension_id);
        const list = valuesByDimension.get(key) ?? [];
        list.push({ id: String(row.id), label: String(row.label), normalizedLabel: String(row.normalized_label), sort: Number(row.sort), archived: row.archived_at !== null });
        valuesByDimension.set(key, list);
    }
    const persistedDimensions = dimensions.rows.map((row) => ({
        id: String(row.id), label: String(row.label), normalizedLabel: String(row.normalized_label), sort: Number(row.sort), archived: row.archived_at !== null, values: valuesByDimension.get(String(row.id)) ?? [],
    }));
    const pairsBySku = new Map();
    for (const row of selections.rows) {
        const list = pairsBySku.get(String(row.sku_id)) ?? [];
        list.push({ dimensionId: String(row.dimension_id), valueId: String(row.value_id) });
        pairsBySku.set(String(row.sku_id), list);
    }
    const persistedSkus = skus.rows.map((row) => ({
        id: String(row.id), skuCode: String(row.sku_code), sequence: Number(row.sequence), combinationKey: String(row.combination_key), pairs: pairsBySku.get(String(row.id)) ?? [], status: String(row.status), suggestedRetailPrice: nullable(row.suggested_retail_price), supplyPrice: nullable(row.supply_price), image: row.image_adapter === null ? null : { adapter: String(row.image_adapter), value: String(row.image_value) }, configVersion: bigint(row.config_version), archived: row.archived_at !== null,
    }));
    const inventory = {};
    for (const row of inventories.rows)
        inventory[String(row.sku_id)] = { quantity: Number(row.quantity), version: bigint(row.version) };
    const commands = receipts.rows.map((row) => ({ commandId: String(row.command_id), fingerprint: String(row.fingerprint), result: row.result }));
    return { scopeKey: root.scope_key, spuId: root.spu_id, registeredSpuCode: root.registered_spu_code, structureVersion: bigint(root.structure_version), nextSequence: Number(root.next_sequence), dimensions: persistedDimensions, skus: persistedSkus, inventories: inventory, commands };
};
const persistDocument = async (client, schemaName, document) => {
    const t = tableNames(schemaName);
    await client.query(`INSERT INTO ${t.product} (scope_key, spu_id, registered_spu_code, structure_version, next_sequence) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (scope_key, spu_id) DO UPDATE SET registered_spu_code = EXCLUDED.registered_spu_code, structure_version = EXCLUDED.structure_version, next_sequence = EXCLUDED.next_sequence, updated_at = now()`, [document.scopeKey, document.spuId, document.registeredSpuCode, document.structureVersion.toString(), document.nextSequence]);
    for (const dimension of document.dimensions) {
        await client.query(`INSERT INTO ${t.dimension} (id, scope_key, spu_id, label, normalized_label, sort, archived_at) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() ELSE NULL END) ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, normalized_label = EXCLUDED.normalized_label, sort = EXCLUDED.sort, archived_at = EXCLUDED.archived_at`, [dimension.id, document.scopeKey, document.spuId, dimension.label, dimension.normalizedLabel, dimension.sort, dimension.archived]);
    }
    for (const dimension of document.dimensions)
        for (const value of dimension.values) {
            await client.query(`INSERT INTO ${t.value} (id, dimension_id, scope_key, spu_id, label, normalized_label, sort, archived_at) VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN now() ELSE NULL END) ON CONFLICT (id) DO UPDATE SET dimension_id = EXCLUDED.dimension_id, label = EXCLUDED.label, normalized_label = EXCLUDED.normalized_label, sort = EXCLUDED.sort, archived_at = EXCLUDED.archived_at`, [value.id, dimension.id, document.scopeKey, document.spuId, value.label, value.normalizedLabel, value.sort, value.archived]);
        }
    for (const sku of document.skus) {
        await client.query(`INSERT INTO ${t.sku} (id, scope_key, spu_id, sku_code, sequence, combination_key, suggested_retail_price, supply_price, image_adapter, image_value, status, config_version, archived_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $13 THEN now() ELSE NULL END) ON CONFLICT (id) DO UPDATE SET suggested_retail_price = EXCLUDED.suggested_retail_price, supply_price = EXCLUDED.supply_price, image_adapter = EXCLUDED.image_adapter, image_value = EXCLUDED.image_value, status = EXCLUDED.status, config_version = EXCLUDED.config_version, archived_at = EXCLUDED.archived_at`, [sku.id, document.scopeKey, document.spuId, sku.skuCode, sku.sequence, sku.combinationKey, sku.suggestedRetailPrice, sku.supplyPrice, sku.image?.adapter ?? null, sku.image?.value ?? null, sku.status, sku.configVersion.toString(), sku.archived]);
    }
    await client.query(`DELETE FROM ${t.selection} WHERE sku_id IN (SELECT id FROM ${t.sku} WHERE scope_key = $1 AND spu_id = $2)`, [document.scopeKey, document.spuId]);
    for (const sku of document.skus)
        for (const pair of sku.pairs)
            await client.query(`INSERT INTO ${t.selection} (sku_id, scope_key, spu_id, dimension_id, value_id) VALUES ($1,$2,$3,$4,$5)`, [sku.id, document.scopeKey, document.spuId, pair.dimensionId, pair.valueId]);
    for (const [skuId, entry] of Object.entries(document.inventories))
        await client.query(`INSERT INTO ${t.inventory} (sku_id, quantity, version) VALUES ($1,$2,$3) ON CONFLICT (sku_id) DO UPDATE SET quantity = EXCLUDED.quantity, version = EXCLUDED.version, updated_at = now()`, [skuId, entry.quantity, entry.version.toString()]);
    await client.query(`DELETE FROM ${t.receipt} WHERE scope_key = $1 AND spu_id = $2 AND expires_at <= now()`, [document.scopeKey, document.spuId]);
    for (const receipt of document.commands)
        await client.query(`INSERT INTO ${t.receipt} (scope_key, spu_id, command_id, command_type, fingerprint, result, expires_at) VALUES ($1,$2,$3,'sku-kit',$4,$5::jsonb,now() + interval '7 days') ON CONFLICT (scope_key, spu_id, command_id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, result = EXCLUDED.result, expires_at = EXCLUDED.expires_at`, [document.scopeKey, document.spuId, receipt.commandId, receipt.fingerprint, JSON.stringify(receipt.result)]);
};
/**
 * A normalized PostgreSQL implementation of the server Store contract.
 * The schema migration must have been explicitly executed by the host first.
 */
export const createPostgresSkuStore = (pool, options = {}) => {
    const schemaName = options.schemaName ?? "public";
    validateSkuSchemaName(schemaName);
    return {
        async transact(scopeKey, spuId, callback) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [scopeKey, spuId]);
                const current = await readDocument(client, schemaName, scopeKey, spuId, true);
                const outcome = await callback(current);
                if (outcome.document !== undefined)
                    await persistDocument(client, schemaName, outcome.document);
                await client.query("COMMIT");
                return outcome.result;
            }
            catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw error;
            }
            finally {
                client.release();
            }
        },
        async read(scopeKey, spuId) {
            const client = await pool.connect();
            try {
                return await readDocument(client, schemaName, scopeKey, spuId);
            }
            finally {
                client.release();
            }
        },
        async findByRegisteredSpuCode(scopeKey, registeredSpuCode) {
            const client = await pool.connect();
            try {
                const row = await client.query(`SELECT scope_key, spu_id FROM ${tableNames(schemaName).product} WHERE scope_key = $1 AND registered_spu_code = $2`, [scopeKey, registeredSpuCode]);
                return row.rows[0] === undefined ? null : readDocument(client, schemaName, scopeKey, row.rows[0].spu_id);
            }
            finally {
                client.release();
            }
        },
        async ensureInventoryAuthority(scopeKey, authority) {
            const client = await pool.connect();
            const t = tableNames(schemaName);
            try {
                const result = await client.query(`INSERT INTO ${t.scope} (scope_key, inventory_authority_kind, authority_key) VALUES ($1,$2,$3) ON CONFLICT (scope_key) DO UPDATE SET version = ${t.scope}.version WHERE ${t.scope}.inventory_authority_kind = EXCLUDED.inventory_authority_kind AND ${t.scope}.authority_key = EXCLUDED.authority_key RETURNING inventory_authority_kind, authority_key`, [scopeKey, authority.kind, authority.authorityKey]);
                if (result.rows.length === 0)
                    return { ok: false, problem: { code: "INVENTORY_AUTHORITY_MISMATCH", message: "库存权威已绑定，不能静默修改", retryable: false } };
                return { ok: true, value: authority };
            }
            finally {
                client.release();
            }
        },
    };
};
/**
 * Binds SKU persistence to a transaction opened by the host. This adapter never
 * begins, commits, rolls back, or releases that transaction; the host owns all
 * of those actions (including its SPU write and lock ordering).
 */
export const createPostgresSkuStoreForTransaction = (client, options = {}) => {
    const schemaName = options.schemaName ?? "public";
    validateSkuSchemaName(schemaName);
    return {
        async transact(scopeKey, spuId, callback) {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [scopeKey, spuId]);
            const current = await readDocument(client, schemaName, scopeKey, spuId, true);
            const outcome = await callback(current);
            if (outcome.document !== undefined)
                await persistDocument(client, schemaName, outcome.document);
            return outcome.result;
        },
        async read(scopeKey, spuId) { return readDocument(client, schemaName, scopeKey, spuId); },
        async findByRegisteredSpuCode(scopeKey, registeredSpuCode) {
            const row = await client.query(`SELECT scope_key, spu_id FROM ${tableNames(schemaName).product} WHERE scope_key = $1 AND registered_spu_code = $2`, [scopeKey, registeredSpuCode]);
            return row.rows[0] === undefined ? null : readDocument(client, schemaName, scopeKey, row.rows[0].spu_id);
        },
        async ensureInventoryAuthority(scopeKey, authority) {
            const t = tableNames(schemaName);
            const result = await client.query(`INSERT INTO ${t.scope} (scope_key, inventory_authority_kind, authority_key) VALUES ($1,$2,$3) ON CONFLICT (scope_key) DO UPDATE SET version = ${t.scope}.version WHERE ${t.scope}.inventory_authority_kind = EXCLUDED.inventory_authority_kind AND ${t.scope}.authority_key = EXCLUDED.authority_key RETURNING inventory_authority_kind`, [scopeKey, authority.kind, authority.authorityKey]);
            return result.rows.length === 0 ? { ok: false, problem: { code: "INVENTORY_AUTHORITY_MISMATCH", message: "库存权威已绑定，不能静默修改", retryable: false } } : { ok: true, value: authority };
        },
    };
};
