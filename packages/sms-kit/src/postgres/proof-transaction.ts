import type { Pool, PoolClient } from "pg";

import type { ConsumeProofInput, ProofService } from "../application/proof-service.js";
import { asSmsTransaction } from "./transaction.js";

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
export async function withPgProofTransaction<T>(
  pool: Pool,
  proofService: ProofService,
  input: ConsumeProofInput,
  work: PgProofTransactionWork<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const consumption = await proofService.consume(input, asSmsTransaction(client));
    const result = consumption.replay ? await work.replay(client) : await work.execute(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}
