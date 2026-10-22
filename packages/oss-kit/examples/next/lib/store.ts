import { and, eq, getTableName, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { OssStore, StoreView, StorageRecord } from "oss-kit";
import type { OssTables } from "./schema";
/** Database and table instances are supplied by the host; no connections or business table singletons. */
export function createDrizzleOssStore(db: NodePgDatabase, tables: OssTables, scope: string): OssStore {
  if (!scope || scope.length > 100) throw new Error("Invalid host scope");
  const { storage, strategies } = tables;
  function view(session: Pick<NodePgDatabase, "select" | "insert">, writable: boolean): StoreView {
    const config = (row: typeof storage.$inferSelect): StorageRecord => {
      const { scope: _scope, ...record } = row; return record;
    };
    return {
      async getStorage(id) { const [row] = await session.select().from(storage).where(and(eq(storage.scope, scope), eq(storage.id, id))); return row ? config(row) : null; },
      async listStorage() { return (await session.select().from(storage).where(eq(storage.scope, scope))).map(config); },
      async saveStorage(record) {
        if (!writable) throw new Error("Read-only store view");
        await session.insert(storage).values({ scope, ...record }).onConflictDoUpdate({ target: [storage.scope, storage.id], set: record });
      },
      async getStrategy(code) { const [row] = await session.select().from(strategies).where(and(eq(strategies.scope, scope), eq(strategies.code, code))); return row?.payload ?? null; },
      async listStrategies() { return (await session.select().from(strategies).where(eq(strategies.scope, scope))).map(row => row.payload); },
      async saveStrategy(strategy) {
        if (!writable) throw new Error("Read-only store view");
        await session.insert(strategies).values({ scope, code: strategy.code, payload: strategy }).onConflictDoUpdate({ target: [strategies.scope, strategies.code], set: { payload: strategy } });
      },
    };
  }
  return {
    async read(work) { return work(view(db, false)); },
    async transaction(work) {
      return db.transaction(async tx => {
        // READ COMMITTED + lock BEFORE reads: serializes same-scope changes across processes/connections.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oss-kit:${getTableName(storage)}:${scope}`}, 0))`);
        return work(view(tx, true));
      });
    },
  };
}
