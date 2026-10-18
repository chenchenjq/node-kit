import type { Pool, PoolClient } from "pg";
import type { ConsumeProofInput, ProofService } from "../application/proof-service.js";
/**
 * `execute` owns the mutation for a first proof consumption; `replay` must only retrieve the
 * result written by that mutation. The split makes same-key replays unable to rerun `execute`.
 */
export type PgProofTransactionWork<Result> = Readonly<{
    execute(client: PoolClient): Promise<Result>;
    replay(client: PoolClient): Promise<Result>;
}>;
/**
 * Consumes a proof and runs a PostgreSQL host write in one transaction.
 *
 * `proofService` is explicit so this helper cannot silently choose a hasher or clock. A
 * same-key replay invokes `work.replay`, never `work.execute`, while holding the proof row lock.
 * For cross-database work, do not use this helper: call `proofService.consume` and make the
 * downstream operation idempotent with exactly `input.consumptionKey` before retrying it.
 */
export declare function withPgProofTransaction<T>(pool: Pool, proofService: ProofService, input: ConsumeProofInput, work: PgProofTransactionWork<T>): Promise<T>;
