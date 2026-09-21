import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ProofService } from "../../../src/application/proof-service.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { HmacHasher } from "../../../src/security/hmac-hasher.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantA = "tenant-proof-a" as TenantId;
const tenantB = "tenant-proof-b" as TenantId;
const now = new Date("2026-09-14T00:00:00.000Z");

describe("ProofService", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let proofService: ProofService;
  let stop: (() => Promise<void>) | undefined;
  const hasher = new HmacHasher(Buffer.alloc(32, 13));

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    proofService = new ProofService({ store, hasher, clock: { now: () => new Date(now) } });
  }, 120_000);

  afterAll(async () => stop?.());

  async function issueProof(tenantId = tenantA, subjectId = "user-1", action = "password.change"): Promise<string> {
    const id = crypto.randomUUID() as never;
    const proof = crypto.randomUUID();
    await store.transaction(async (tx) => {
      await store.challenges.create({
        id,
        tenantId,
        idempotencyKey: crypto.randomUUID(),
        subjectId,
        action,
        purpose: "password_change",
        policyVersion: 1,
        otpLength: 6,
        otpTtlSeconds: 300,
        proofTtlSeconds: 300,
        phoneHash: "phone-hash",
        codeHash: "code-hash",
        maxAttempts: 3,
        expiresAt: new Date(now.getTime() + 300_000),
      }, tx);
      await store.challenges.markDeliveryAcceptance({ tenantId, id, status: "accepted" }, tx);
      await store.challenges.verify({
        tenantId,
        id,
        verifiedAt: now,
        proofHash: await hasher.hash(`${tenantId}\u0000${subjectId}\u0000${action}\u0000${proof}`),
        proofExpiresAt: new Date(now.getTime() + 300_000),
      }, tx);
    });
    return proof;
  }

  it("returns the same successful consumption for the same operation key", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenantA, proof, subjectId: "user-1", action: "password.change", consumptionKey: "pwd:change:42" };

    await expect(proofService.consume(input)).resolves.toMatchObject({ consumed: true, replay: false });
    await expect(proofService.consume(input)).resolves.toMatchObject({ consumed: true, replay: true });
  });

  it("rejects a second operation key for one proof", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenantA, proof, subjectId: "user-1", action: "password.change", consumptionKey: "operation-a" };

    await proofService.consume(input);
    await expect(proofService.consume({ ...input, consumptionKey: "operation-b" })).rejects.toMatchObject({ code: "PROOF_INVALID" });
  });

  it("serializes concurrent same-key replay", async () => {
    const proof = await issueProof();
    const input = { tenantId: tenantA, proof, subjectId: "user-1", action: "password.change", consumptionKey: "operation-race" };

    const results = await Promise.all([proofService.consume(input), proofService.consume(input)]);

    expect(results.map((result) => result.replay).sort()).toEqual([false, true]);
  });

  it.each([
    ["subject", { subjectId: "user-2" }],
    ["action", { action: "step.up" }],
    ["tenant", { tenantId: tenantB }],
  ])("does not burn a proof when its %s binding is wrong", async (_binding, mismatch) => {
    const proof = await issueProof();
    const input = { tenantId: tenantA, proof, subjectId: "user-1", action: "password.change", consumptionKey: "operation-binding" };

    await expect(proofService.consume({ ...input, ...mismatch })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    await expect(proofService.consume(input)).resolves.toMatchObject({ consumed: true, replay: false });
  });
});
