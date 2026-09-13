import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ChallengeService } from "../../../src/application/challenge-service.js";
import { SendService } from "../../../src/application/send-service.js";
import type { TenantId } from "../../../src/core/types.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { HmacHasher } from "../../../src/security/hmac-hasher.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;

describe("ChallengeService", () => {
  let pool: Pool;
  let service: ChallengeService;
  let stop: (() => Promise<void>) | undefined;
  let now = new Date("2026-09-13T02:00:00.000Z");
  let providerOutcome: "accepted" | "rejected" | "unknown" = "accepted";
  let sends = 0;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    const store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "sign-challenge", changeType: "new", checksum: "challenge-signature", resourceType: "signature", snapshot: { kind: "signature", externalName: "Challenge", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "template-challenge", changeType: "new", checksum: "challenge-template", resourceType: "template", signatureExternalKey: "sign-challenge", templateKey: "auth.password_change", purpose: "auth.password_change", snapshot: { kind: "template", externalCode: "SMS_CHALLENGE", externalName: "Challenge", externalStatus: "approved", templateType: "verification", variableNames: ["code"] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date("2026-09-13T00:00:00.000Z"), expectedVersion: config.version });

    const clock = { now: () => new Date(now) };
    const phoneProtector = { protect: async (phone: string) => ({ ciphertext: "phone", keyId: "phone-k1", lookupHash: `phone-${phone}`, last4: phone.slice(-4), masked: "138****0000" }) };
    const sendService = new SendService({
      store,
      provider: { send: async () => {
        sends += 1;
        return providerOutcome === "accepted"
          ? { kind: "accepted" as const, bizId: `biz-${sends}`, requestId: `req-${sends}` }
          : providerOutcome === "rejected"
            ? { kind: "rejected" as const, code: "isv.BUSINESS_LIMIT_CONTROL", retryable: false }
            : { kind: "unknown" as const, code: "ACCEPTANCE_UNKNOWN" as const };
      } } as never,
      phoneProtector: phoneProtector as never,
      payloadProtector: { seal: async () => ({ ciphertext: "params", keyId: "params-k1" }) } as never,
      clock,
      ids: { next: () => crypto.randomUUID(), messageId: () => crypto.randomUUID() as never },
      events: { emit: () => undefined },
      providerTimeoutMs: 1_000,
    });
    service = new ChallengeService({
      store,
      sendService,
      phoneProtector: phoneProtector as never,
      hasher: new HmacHasher(Buffer.alloc(32, 7)),
      clock,
      ids: { next: () => crypto.randomUUID() },
      otpGenerator: { generate: () => "123456" },
    });
  }, 120_000);

  afterAll(async () => stop?.());

  it("issues a five-minute challenge without storing the code", async () => {
    const issued = await service.issue({
      tenantId: tenantA,
      subjectId: "user-1",
      action: "password.change",
      phone: "13800138000",
      idempotencyKey: "user-1:password.change:1",
    });
    const persisted = await pool.query("select row_to_json(challenge)::text as challenge, policy_version, otp_length, otp_ttl_seconds, max_attempts, proof_ttl_seconds from sms_kit.otp_challenge challenge where id = $1", [issued.id]);

    expect(issued.expiresAt).toEqual(new Date("2026-09-13T02:05:00.000Z"));
    expect(persisted.rows[0]?.challenge).not.toContain("123456");
    expect(persisted.rows[0]).toMatchObject({ policy_version: "1", otp_length: 6, otp_ttl_seconds: 300, max_attempts: 3, proof_ttl_seconds: 300 });

    await expect(service.issue({ tenantId: tenantA, subjectId: "user-1", action: "password.change", phone: "13800138000", idempotencyKey: "user-1:password.change:1" }))
      .resolves.toEqual(issued);
    expect(sends).toBe(1);
  });

  it("invalidates a challenge after three wrong codes", async () => {
    const issued = await service.issue({ tenantId: tenantA, subjectId: "user-2", action: "password.change", phone: "13800138001", idempotencyKey: "user-2:password.change:1" });

    for (let index = 0; index < 3; index += 1) {
      await expect(service.verify({ tenantId: tenantA, challengeId: issued.id, code: "000000" })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    }
    await expect(service.verify({ tenantId: tenantA, challengeId: issued.id, code: "123456" })).rejects.toMatchObject({ code: "CHALLENGE_ATTEMPTS_EXCEEDED" });
  });

  it("serializes concurrent wrong checks at the challenge attempt limit", async () => {
    const issued = await service.issue({ tenantId: tenantA, subjectId: "user-3", action: "password.change", phone: "13800138002", idempotencyKey: "user-3:password.change:1" });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => service.verify({ tenantId: tenantA, challengeId: issued.id, code: "000000" })));

    expect(results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "PROOF_INVALID")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "CHALLENGE_ATTEMPTS_EXCEEDED")).toHaveLength(1);
  });

  it("rejects an expired challenge without checking its code", async () => {
    const issued = await service.issue({ tenantId: tenantA, subjectId: "user-4", action: "password.change", phone: "13800138003", idempotencyKey: "user-4:password.change:1" });
    now = new Date("2026-09-13T02:05:00.000Z");

    await expect(service.verify({ tenantId: tenantA, challengeId: issued.id, code: "123456" })).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    now = new Date("2026-09-13T02:00:00.000Z");
  });

  it("returns one tenant-bound proof without persisting it in plaintext", async () => {
    const issued = await service.issue({ tenantId: tenantA, subjectId: "user-5", action: "password.change", phone: "13800138004", idempotencyKey: "user-5:password.change:1" });

    await expect(service.verify({ tenantId: tenantB, challengeId: issued.id, code: "123456" })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    const verified = await service.verify({ tenantId: tenantA, challengeId: issued.id, code: "123456" });
    const persisted = await pool.query("select row_to_json(challenge)::text as challenge from sms_kit.otp_challenge challenge where id = $1", [issued.id]);

    expect(verified.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(persisted.rows[0]?.challenge).not.toContain(verified.proof);
  });

  it("invalidates the stored challenge when direct delivery is rejected", async () => {
    providerOutcome = "rejected";
    try {
      await expect(service.issue({ tenantId: tenantA, subjectId: "user-6", action: "password.change", phone: "13800138005", idempotencyKey: "user-6:password.change:1" })).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    } finally {
      providerOutcome = "accepted";
    }
    expect((await pool.query("select count(*)::text as count from sms_kit.otp_challenge where subject_id = 'user-6' and invalidated_at is null")).rows).toEqual([{ count: "0" }]);
  });

  it("invalidates an acceptance-unknown challenge and requires a fresh request", async () => {
    providerOutcome = "unknown";
    const input = { tenantId: tenantA, subjectId: "user-7", action: "password.change" as const, phone: "13800138006", idempotencyKey: "user-7:password.change:1" };
    const sentBefore = sends;
    try {
      await expect(service.issue(input)).rejects.toMatchObject({ code: "ACCEPTANCE_UNKNOWN", message: expect.stringContaining("fresh") });
      await expect(service.issue(input)).rejects.toMatchObject({ code: "ACCEPTANCE_UNKNOWN", message: expect.stringContaining("fresh") });
    } finally {
      providerOutcome = "accepted";
    }
    expect(sends).toBe(sentBefore + 1);
    expect((await pool.query("select terminal_error_code from sms_kit.otp_challenge where subject_id = 'user-7'")).rows).toEqual([{ terminal_error_code: "ACCEPTANCE_UNKNOWN" }]);
  });
});
