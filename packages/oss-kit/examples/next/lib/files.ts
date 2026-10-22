import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FileReference } from "oss-kit";
import type { OssTables } from "./schema";
export interface HostFileRecord { id: string; scope: string; ownerId: string; reference: FileReference }
export interface HostFileRepository {
  save(scope: string, ownerId: string, reference: FileReference): Promise<string>;
  get(scope: string, id: string): Promise<HostFileRecord | null>;
  find(scope: string, reference: FileReference): Promise<HostFileRecord | null>;
  remove(scope: string, id: string): Promise<void>;
}
export function createExampleFileRepository(db: NodePgDatabase, tables: OssTables): HostFileRepository {
  const files = tables.files;
  return {
    async save(scope, ownerId, reference) { const id = randomUUID(); await db.insert(files).values({ id, scope, ownerId, reference }); return id; },
    async get(scope, id) { const [row] = await db.select().from(files).where(and(eq(files.scope, scope), eq(files.id, id))); return row ?? null; },
    async find(scope, reference) { const [row] = await db.select().from(files).where(and(eq(files.scope, scope), sql`${files.reference}->>'storageConfigId' = ${reference.storageConfigId}`, sql`${files.reference}->>'objectKey' = ${reference.objectKey}`)); return row ?? null; },
    async remove(scope, id) { await db.delete(files).where(and(eq(files.scope, scope), eq(files.id, id))); },
  };
}
