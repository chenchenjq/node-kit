import type { SkuStore } from "../server/contracts.js";
/** The small subset of `pg` used by the adapter, so consumers control pool setup. */
export interface PgQueryClient {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{
        rows: Row[];
    }>;
    release(): void;
}
export interface PgPool {
    connect(): Promise<PgQueryClient>;
}
export interface PgTransactionClient {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{
        rows: Row[];
    }>;
}
/**
 * A normalized PostgreSQL implementation of the server Store contract.
 * The schema migration must have been explicitly executed by the host first.
 */
export declare const createPostgresSkuStore: (pool: PgPool, options?: {
    schemaName?: string;
}) => SkuStore;
/**
 * Binds SKU persistence to a transaction opened by the host. This adapter never
 * begins, commits, rolls back, or releases that transaction; the host owns all
 * of those actions (including its SPU write and lock ordering).
 */
export declare const createPostgresSkuStoreForTransaction: (client: PgTransactionClient, options?: {
    schemaName?: string;
}) => SkuStore;
