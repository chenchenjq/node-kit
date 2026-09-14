import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

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
    await pool.query("create table host_proof_operation (id text primary key, execution_count integer not null)");
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

  it("rolls back both the host insert and proof consumption when the host operation fails", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenant, proof, subjectId: "user-1", action: "password.change", consumptionKey: "password:42" };

    await expect(withPgProofTransaction(pool, proofService, input, {
      execute: async (client) => {
        await client.query("insert into host_proof_operation (id, execution_count) values ($1, 1)", [input.consumptionKey]);
        throw new Error("business write failed");
      },
      replay: async () => {
        throw new Error("a rolled-back operation cannot replay");
      },
    })).rejects.toThrow("business write failed");

    await expect(pool.query("select id from host_proof_operation where id = $1", [input.consumptionKey])).resolves.toMatchObject({ rows: [] });
    await expect(proofService.consume(input)).resolves.toMatchObject({ consumed: true, replay: false });
  });

  it("uses a replay reader instead of running the host mutation twice for the same key", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenant, proof, subjectId: "user-1", action: "password.change", consumptionKey: "password:43" };
    let executions = 0;
    let replays = 0;
    const work = {
      execute: async (client: PoolClient) => {
        executions += 1;
        await client.query("insert into host_proof_operation (id, execution_count) values ($1, 1)", [input.consumptionKey]);
        return 1;
      },
      replay: async (client: PoolClient) => {
        replays += 1;
        return (await client.query<{ execution_count: number }>("select execution_count from host_proof_operation where id = $1", [input.consumptionKey])).rows[0]?.execution_count;
      },
    };

    await expect(withPgProofTransaction(pool, proofService, input, work)).resolves.toBe(1);
    await expect(withPgProofTransaction(pool, proofService, input, work)).resolves.toBe(1);

    expect({ executions, replays }).toEqual({ executions: 1, replays: 1 });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from host_proof_operation where id = $1", [input.consumptionKey])).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("runs one host mutation and one replay reader for concurrent same-key consumers", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenant, proof, subjectId: "user-1", action: "password.change", consumptionKey: "password:44" };
    let executions = 0;
    let replays = 0;
    const work = {
      execute: async (client: PoolClient) => {
        executions += 1;
        await client.query("insert into host_proof_operation (id, execution_count) values ($1, 1)", [input.consumptionKey]);
        return 1;
      },
      replay: async (client: PoolClient) => {
        replays += 1;
        return (await client.query<{ execution_count: number }>("select execution_count from host_proof_operation where id = $1", [input.consumptionKey])).rows[0]?.execution_count;
      },
    };

    await expect(Promise.all([
      withPgProofTransaction(pool, proofService, input, work),
      withPgProofTransaction(pool, proofService, input, work),
    ])).resolves.toEqual([1, 1]);

    expect({ executions, replays }).toEqual({ executions: 1, replays: 1 });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from host_proof_operation where id = $1", [input.consumptionKey])).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("permits exactly one host operation for concurrent distinct consumption keys", async () => {
    const proof = await issueProof();
    let executions = 0;
    const operation = (consumptionKey: string) => withPgProofTransaction(pool, proofService, {
      tenantId: tenant, proof, subjectId: "user-1", action: "password.change", consumptionKey,
    }, {
      execute: async (client) => {
        executions += 1;
        await client.query("insert into host_proof_operation (id, execution_count) values ($1, 1)", [consumptionKey]);
        return consumptionKey;
      },
      replay: async () => {
        throw new Error("a different key cannot replay this operation");
      },
    });

    const results = await Promise.allSettled([operation("password:45a"), operation("password:45b")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "PROOF_INVALID")).toHaveLength(1);
    expect(executions).toBe(1);
    await expect(pool.query<{ count: string }>("select count(*)::text as count from host_proof_operation where id in ($1, $2)", ["password:45a", "password:45b"])).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });
});
