import { and, asc, eq, getTableName, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DictionaryPort, Plan } from "ai-kit";
import type { AiStore, ConnectionRecord, StoreView } from "ai-kit/server";
import type { AiTables } from "./schema";
export function createDrizzleAiStore(
  db: NodePgDatabase,
  tables: AiTables,
  scope: string,
): AiStore {
  if (!scope || scope.length > 100)
    throw new Error("Invalid trusted host scope");
  const { connections, plans } = tables;
  function view(
    session: Pick<NodePgDatabase, "select" | "insert" | "delete">,
    writable: boolean,
  ): StoreView {
    const connection = (
      row: typeof connections.$inferSelect,
    ): ConnectionRecord => {
      const { scope: _scope, ...c } = row;
      return c;
    };
    const plan = (row: typeof plans.$inferSelect): Plan => {
      const { scope: _scope, ...p } = row;
      return p;
    };
    const write = () => {
      if (!writable) throw new Error("Read-only view");
    };
    return {
      async getConnection(id) {
        const [row] = await session
          .select()
          .from(connections)
          .where(and(eq(connections.scope, scope), eq(connections.id, id)));
        return row ? connection(row) : null;
      },
      async listConnections() {
        return (
          await session
            .select()
            .from(connections)
            .where(eq(connections.scope, scope))
        ).map(connection);
      },
      async saveConnection(c) {
        write();
        await session
          .insert(connections)
          .values({ scope, ...c })
          .onConflictDoUpdate({
            target: [connections.scope, connections.id],
            set: c,
          });
      },
      async deleteConnection(id) {
        write();
        await session
          .delete(connections)
          .where(and(eq(connections.scope, scope), eq(connections.id, id)));
      },
      async getPlan(code) {
        const [row] = await session
          .select()
          .from(plans)
          .where(and(eq(plans.scope, scope), eq(plans.code, code)));
        return row ? plan(row) : null;
      },
      async listPlans() {
        return (
          await session.select().from(plans).where(eq(plans.scope, scope))
        ).map(plan);
      },
      async savePlan(p) {
        write();
        await session
          .insert(plans)
          .values({ scope, ...p })
          .onConflictDoUpdate({ target: [plans.scope, plans.code], set: p });
      },
    };
  }
  return {
    read: (work) =>
      db.transaction((tx) => work(view(tx, false)), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }),
    transaction: (work) =>
      db.transaction(
        async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-kit:${getTableName(connections)}:${scope}`},0))`,
          );
          return work(view(tx, true));
        },
        { isolationLevel: "read committed" },
      ),
  };
}
export function createFallbackDictionary(
  db: NodePgDatabase,
  tables: AiTables,
  scope: string,
): DictionaryPort {
  const { dictionaryTypes: types, dictionaryItems: items } = tables;
  return {
    async insertTypeIfAbsent(code, name) {
      await db
        .insert(types)
        .values({ scope, code, name })
        .onConflictDoNothing();
    },
    async insertItemIfAbsent(type, item) {
      await db
        .insert(items)
        .values({ scope, type, ...item })
        .onConflictDoNothing();
    },
    async listItems(type) {
      return (
        await db
          .select()
          .from(items)
          .where(and(eq(items.scope, scope), eq(items.type, type)))
          .orderBy(asc(items.sort), asc(items.code))
      ).map(({ scope: _s, type: _t, ...item }) => item);
    },
  };
}
