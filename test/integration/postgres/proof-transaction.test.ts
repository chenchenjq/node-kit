import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ProofService } from "../../../src/application/proof-service.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { withPgProofTransaction } from "../../../src/postgres/proof-transaction.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { HmacHasher } from "../../../src/security/hmac-hasher.js";
import { startPostgres } from "./helpers.js";

const tenant = "tenant-proof-transaction" as TenantId;
const now = new Date("2026-09-14T00:00:00.000Z");

describe("withPgProofTransaction", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let proofService: ProofService;
  let stop: (() => Promise<void>) | undefined;
  const hasher = new HmacHasher(Buffer.alloc(32, 14));

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    proofService = new ProofService({ store, hasher, clock: { now: () => new Date(now) } });
  }, 120_000);

  afterAll(async () => stop?.());

  async function issueProof(): Promise<string> {
    const id = crypto.randomUUID() as never;
    const proof = crypto.randomUUID();
    await store.transaction(async (tx) => {
      await store.challenges.create({ id, tenantId: tenant, idempotencyKey: crypto.randomUUID(), subjectId: "user-1", action: "password.change", purpose: "password_change", policyVersion: 1, otpLength: 6, otpTtlSeconds: 300, proofTtlSeconds: 300, phoneHash: "phone-hash", codeHash: "code-hash", maxAttempts: 3, expiresAt: new Date(now.getTime() + 300_000) }, tx);
      await store.challenges.markDeliveryAcceptance({ tenantId: tenant, id, status: "accepted" }, tx);
      await store.challenges.verify({ tenantId: tenant, id, verifiedAt: now, proofHash: await hasher.hash(`${tenant}\u0000user-1\u0000password.change\u0000${proof}`), proofExpiresAt: new Date(now.getTime() + 300_000) }, tx);
    });
    return proof;
  }

  it("rolls back proof consumption when the same-database operation fails", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenant, proof, subjectId: "user-1", action: "password.change", consumptionKey: "password:42" };

    await expect(withPgProofTransaction(pool, proofService, input, async () => {
      throw new Error("business write failed");
    })).rejects.toThrow("business write failed");

    await expect(proofService.consume(input)).resolves.toMatchObject({ consumed: true, replay: false });
  });

  it("passes the host client to the work after consuming its proof", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenant, proof, subjectId: "user-1", action: "password.change", consumptionKey: "password:43" };

    const result = await withPgProofTransaction(pool, proofService, input, async (client) => {
      await client.query("create table if not exists proof_transaction_check (id text primary key)");
      await client.query("insert into proof_transaction_check (id) values ($1)", [input.consumptionKey]);
      return (await client.query<{ id: string }>("select id from proof_transaction_check where id = $1", [input.consumptionKey])).rows[0]?.id;
    });

    expect(result).toBe("password:43");
    await expect(proofService.consume(input)).resolves.toMatchObject({ consumed: true, replay: true });
  });
});
