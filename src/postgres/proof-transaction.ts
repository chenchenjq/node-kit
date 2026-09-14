import type { Pool, PoolClient } from "pg";

import type { ConsumeProofInput, ProofService } from "../application/proof-service.js";
import { asSmsTransaction } from "./transaction.js";

/**
 * Consumes a proof and runs a PostgreSQL host write in one transaction.
 *
 * `proofService` is explicit so this helper cannot silently choose a hasher or clock. For
 * cross-database work, do not use this helper: call `proofService.consume` and make the
 * downstream operation idempotent with exactly `input.consumptionKey` before retrying it.
 */
export async function withPgProofTransaction<T>(
  pool: Pool,
  proofService: ProofService,
  input: ConsumeProofInput,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await proofService.consume(input, asSmsTransaction(client));
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}
