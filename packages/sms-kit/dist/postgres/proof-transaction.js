import { asSmsTransaction } from "./transaction.js";
/**
 * Consumes a proof and runs a PostgreSQL host write in one transaction.
 *
 * `proofService` is explicit so this helper cannot silently choose a hasher or clock. A
 * same-key replay invokes `work.replay`, never `work.execute`, while holding the proof row lock.
 * For cross-database work, do not use this helper: call `proofService.consume` and make the
 * downstream operation idempotent with exactly `input.consumptionKey` before retrying it.
 */
export async function withPgProofTransaction(pool, proofService, input, work) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const consumption = await proofService.consume(input, asSmsTransaction(client));
        const result = consumption.replay ? await work.replay(client) : await work.execute(client);
        await client.query("commit");
        return result;
    }
    catch (error) {
        try {
            await client.query("rollback");
        }
        catch { /* Preserve the original failure. */ }
        throw error;
    }
    finally {
        client.release();
    }
}
