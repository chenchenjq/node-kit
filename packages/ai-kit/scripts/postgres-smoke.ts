import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  createAiKit,
  createEnvironmentSecretProtector,
} from "../dist/server/index.js";
import { createAiTables } from "../examples/next/lib/schema.js";
import {
  createDrizzleAiStore,
  createFallbackDictionary,
} from "../examples/next/lib/store.js";
const connection = JSON.parse(process.env.AI_KIT_TEST_POSTGRES ?? "null") as {
  database: string;
} | null;
if (connection?.database !== "ai_kit_ephemeral_test")
  throw new Error("Requires isolated generated test database");
const pool = new Pool(connection);
try {
  await pool.query(
    await readFile(
      new URL("../examples/next/migration.sql", import.meta.url),
      "utf8",
    ),
  );
  const db = drizzle(pool),
    tables = createAiTables(),
    scope = "isolated",
    store = createDrizzleAiStore(db, tables, scope),
    dictionary = createFallbackDictionary(db, tables, scope);
  const kit = createAiKit({
    scope,
    store,
    dictionary,
    secrets: createEnvironmentSecretProtector(["MOCK"], () => "mock-key"),
    authorize: async () => true,
    rateLimit: async () => true,
    allowURL: async () => true,
    transport: {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async () => {
        throw new Error("No network in database test");
      },
    },
  });
  await Promise.all([
    kit.initializeDictionary(null),
    kit.initializeDictionary(null),
  ]);
  assert.equal((await kit.listProviders(null)).length, 9);
  await pool.query(
    "UPDATE ai_kit_dictionary_items SET name='管理员',sort=999,enabled=false WHERE scope=$1 AND code='qwen'",
    [scope],
  );
  await kit.initializeDictionary(null);
  assert.equal(
    (await kit.listProviders(null)).find((p) => p.code === "qwen")?.name,
    "管理员",
  );
  await pool.query(
    "UPDATE ai_kit_dictionary_items SET enabled=true WHERE scope=$1 AND code='qwen'",
    [scope],
  );
  const c = await kit.saveConnection(null, {
    name: "q",
    providerCode: "qwen",
    protocol: "openai-chat",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "env:MOCK",
    enabled: true,
  });
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      kit.savePlan(null, {
        code: `p${i}`,
        name: `p${i}`,
        modelId: "qwen-plus",
        connectionId: c.id,
        enabled: true,
        isDefault: true,
      }),
    ),
  );
  assert.equal(
    (await kit.listPlans(null)).filter((p) => p.isDefault).length,
    1,
  );
  await assert.rejects(
    pool.query("UPDATE ai_kit_plans SET is_default=true WHERE scope=$1", [
      scope,
    ]),
    (e) => !!e && typeof e === "object" && "code" in e && e.code === "23505",
  );
  await assert.rejects(kit.deleteConnection(null, c.id, c.revision));
  const other = createDrizzleAiStore(db, tables, "other");
  assert.equal((await other.read((v) => v.listPlans())).length, 0);
  await assert.rejects(
    pool.query(
      "INSERT INTO ai_kit_plans SELECT 'other',id,code,name,connection_id,model_id,enabled,false,system_prompt,parameters,revision FROM ai_kit_plans LIMIT 1",
    ),
    (e) => !!e && typeof e === "object" && "code" in e && e.code === "23503",
  );
  await kit.saveConnection(null, {
    id: c.id,
    revision: c.revision,
    name: c.name,
    providerCode: c.providerCode,
    protocol: c.protocol,
    baseURL: c.baseURL,
    enabled: false,
    clearDefault: true,
  });
  assert.equal(
    (await kit.listPlans(null)).filter((p) => p.isDefault).length,
    0,
  );
  console.log(
    "PostgreSQL: 12 concurrent defaults, unique constraint, scoped FK, dictionary idempotence, disable/default cleanup PASS",
  );
} finally {
  await pool.end();
}
