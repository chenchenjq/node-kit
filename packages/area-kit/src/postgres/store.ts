import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { AreaKitError } from "../errors.js";
import type { AreaStore, ReadView, WriteView } from "../server/ports.js";
import { createAreaTables, type AreaTables } from "./schema.js";
import { createReadView } from "./read-view.js";
import { lockAreaLibrary } from "./locks.js";

function createWriteView(db: NodePgDatabase, tables: AreaTables): WriteView {
  const read = createReadView(db, tables);
  const { region, dataset } = tables;
  return {
    ...read,
    async updatePresentation(datasetId, code, revision, patch) {
      // Copy only supported presentation fields; never spread untrusted input into an update.
      const changes: Partial<typeof region.$inferInsert> = { revision: revision + 1, updatedAt: new Date() };
      if (patch.displayName !== undefined) changes.displayName = patch.displayName;
      if (patch.sort !== undefined) changes.sort = patch.sort;
      if (patch.enabled !== undefined) changes.enabled = patch.enabled;
      const updated = await db.update(region).set(changes).where(and(eq(region.datasetId, datasetId),
        eq(region.code, code), eq(region.revision, revision))).returning({ code: region.code });
      return updated.length ? (await read.findNodes(datasetId, [code]))[0]! : null;
    },
    async setActive(datasetId) {
      const [target] = await db.select().from(dataset).where(eq(dataset.id, datasetId)).limit(1);
      if (!target || target.status !== "ready" || target.importReport.passed !== true) {
        throw new AreaKitError("VERSION_UNAVAILABLE");
      }
      if (target.isActive) return;
      await db.update(dataset).set({ isActive: false, updatedAt: sql`now()` }).where(eq(dataset.isActive, true));
      await db.update(dataset).set({ isActive: true, updatedAt: sql`now()` }).where(eq(dataset.id, datasetId));
    },
  };
}

/** The proxy also guards method references captured before the callback returned. */
async function scoped<T, V extends ReadView>(view: V, work: (view: V) => Promise<T>): Promise<T> {
  let active = true;
  const guarded = new Proxy(view, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (!active) throw new AreaKitError("INVALID_CONFIG");
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  try { return await work(guarded); } finally { active = false; }
}

export function createDrizzleAreaStore(pool: Pool, options: { schemaName?: string } = {}): AreaStore {
  const schemaName = options.schemaName ?? "public";
  const tables = createAreaTables(schemaName);
  async function transaction<T>(write: boolean, work: (view: WriteView) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let began = false;
    let discard: Error | undefined;
    try {
      await client.query(write ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      began = true;
      await client.query("SET LOCAL search_path TO public");
      // READ COMMITTED takes the first state snapshot after a waiting writer acquires this lock.
      if (write) await lockAreaLibrary(client, schemaName, "exclusive");
      const db = drizzle(client);
      const view = write ? createWriteView(db, tables) : createReadView(db, tables);
      const result = await scoped(view, work as (view: ReadView) => Promise<T>);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (began) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) { discard = rollbackError instanceof Error ? rollbackError : new Error("Rollback failed"); }
      } else { discard = error instanceof Error ? error : new Error("Transaction failed"); }
      throw error;
    } finally { client.release(discard); }
  }
  return {
    read: work => transaction(false, work),
    write: work => transaction(true, work),
  };
}

/** Host-owned BEGIN/locks/COMMIT. Bound reads never acquire, release or upgrade a transaction. */
export function bindAreaStore(client: PoolClient, options: { schemaName?: string } = {}): AreaStore {
  const tables = createAreaTables(options.schemaName ?? "public");
  return {
    async read(work) {
      await client.query("SET LOCAL search_path TO public");
      return scoped(createReadView(drizzle(client), tables), work);
    },
    async write() { throw new AreaKitError("INVALID_CONFIG"); },
  };
}
