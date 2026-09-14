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
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;

describe("ChallengeService", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let service: ChallengeService;
  let stop: (() => Promise<void>) | undefined;
  let now = new Date("2026-09-13T02:00:00.000Z");
  let providerOutcome: "accepted" | "rejected" | "throttled" | "unknown" | "deferred" = "accepted";
  let deferredStarted: (() => void) | undefined;
  let resolveDeferred: ((result:
    | { kind: "accepted"; bizId: string; requestId: string }
    | { kind: "rejected"; code: string; retryable: boolean }
    | { kind: "unknown"; code: "ACCEPTANCE_UNKNOWN" }
  ) => void) | undefined;
  let sends = 0;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "sign-challenge", changeType: "new", checksum: "challenge-signature", resourceType: "signature", snapshot: { kind: "signature", externalName: "Challenge", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "template-challenge", changeType: "new", checksum: "challenge-template", resourceType: "template", signatureExternalKey: "sign-challenge", templateKey: "auth.password_change", purpose: "auth.password_change", snapshot: { kind: "template", externalCode: "SMS_CHALLENGE", externalName: "Challenge", externalStatus: "approved", templateType: "verification", variableNames: ["code"] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await commitResourceFixturePreview(store, preview);
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
            : providerOutcome === "throttled"
              ? { kind: "rejected" as const, code: "isv.BUSINESS_LIMIT_CONTROL", retryable: true }
            : providerOutcome === "unknown"
              ? { kind: "unknown" as const, code: "ACCEPTANCE_UNKNOWN" as const }
              : new Promise<
                | { kind: "accepted"; bizId: string; requestId: string }
                | { kind: "rejected"; code: string; retryable: boolean }
                | { kind: "unknown"; code: "ACCEPTANCE_UNKNOWN" }
              >((resolve) => {
                resolveDeferred = resolve;
                deferredStarted?.();
              });
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
      pendingReplayWaitMs: 250,
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

  it("waits for a deferred accepted direct-delivery replay before exposing its challenge", async () => {
    providerOutcome = "deferred";
    const input = { tenantId: tenantA, subjectId: "user-8", action: "password.change" as const, phone: "13800138007", idempotencyKey: "user-8:password.change:1" };
    const started = new Promise<void>((resolve) => { deferredStarted = resolve; });
    const first = service.issue(input);
    await started;
    const replay = service.issue(input);
    let replaySettled = false;
    void replay.finally(() => { replaySettled = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(replaySettled).toBe(false);

    resolveDeferred?.({ kind: "accepted", bizId: "biz-deferred", requestId: "req-deferred" });
    const [firstResult, replayResult] = await Promise.all([first, replay]);
    expect(replayResult).toEqual(firstResult);
    await expect(service.verify({ tenantId: tenantA, challengeId: replayResult.id, code: "123456" })).resolves.toMatchObject({ proof: expect.any(String) });
    providerOutcome = "accepted";
    deferredStarted = undefined;
    resolveDeferred = undefined;
  });

  it.each([
    ["rejected", { kind: "rejected" as const, code: "isv.BUSINESS_LIMIT_CONTROL", retryable: false }, "PROVIDER_REJECTED"],
    ["unknown", { kind: "unknown" as const, code: "ACCEPTANCE_UNKNOWN" as const }, "ACCEPTANCE_UNKNOWN"],
  ])("waits for a deferred %s direct-delivery replay and returns its exact terminal outcome", async (_name, deferredResult, errorCode) => {
    providerOutcome = "deferred";
    const input = { tenantId: tenantA, subjectId: `user-deferred-${errorCode}`, action: "password.change" as const, phone: errorCode === "PROVIDER_REJECTED" ? "13800138012" : "13800138013", idempotencyKey: `user-deferred:${errorCode}` };
    const started = new Promise<void>((resolve) => { deferredStarted = resolve; });
    const first = service.issue(input).then(
      () => { throw new Error("expected direct delivery terminal outcome"); },
      (error: unknown) => error as { toJSON(): unknown },
    );
    await started;
    const replay = service.issue(input).then(
      () => { throw new Error("expected replay terminal outcome"); },
      (error: unknown) => error as { toJSON(): unknown },
    );
    resolveDeferred?.(deferredResult);
    const [firstError, replayError] = await Promise.all([first, replay]);

    expect(replayError.toJSON()).toEqual(firstError.toJSON());
    expect(replayError.toJSON()).toMatchObject({ code: errorCode });
    providerOutcome = "accepted";
    deferredStarted = undefined;
    resolveDeferred = undefined;
  });

  it("recovers a crashed pending direct dispatch as acceptance-unknown after the bounded replay wait", async () => {
    providerOutcome = "deferred";
    const input = { tenantId: tenantA, subjectId: "user-deferred-recovery", action: "password.change" as const, phone: "13800138014", idempotencyKey: "user-deferred:recovery" };
    const started = new Promise<void>((resolve) => { deferredStarted = resolve; });
    const first = service.issue(input).then(
      () => { throw new Error("recovered pending dispatch must not become verifiable"); },
      (error: unknown) => error as { toJSON(): unknown },
    );
    await started;
    const replay = await service.issue(input).then(
      () => { throw new Error("stale pending replay must not succeed"); },
      (error: unknown) => error as { toJSON(): unknown },
    );
    expect(replay.toJSON()).toMatchObject({ code: "ACCEPTANCE_UNKNOWN" });
    resolveDeferred?.({ kind: "accepted", bizId: "biz-late", requestId: "req-late" });
    await expect(first).resolves.toMatchObject({ toJSON: expect.any(Function) });
    providerOutcome = "accepted";
    deferredStarted = undefined;
    resolveDeferred = undefined;
  });

  it("serializes concurrent tenant idempotency requests to one challenge outcome", async () => {
    const input = { tenantId: tenantA, subjectId: "user-9", action: "password.change" as const, phone: "13800138008", idempotencyKey: "user-9:password.change:1" };
    const results = await Promise.all([service.issue(input), service.issue(input)]);

    expect(results[0]).toEqual(results[1]);
  });

  it("replays the same safe terminal error after a throttled direct delivery", async () => {
    providerOutcome = "throttled";
    const input = { tenantId: tenantA, subjectId: "user-10", action: "password.change" as const, phone: "13800138009", idempotencyKey: "user-10:password.change:1" };
    try {
      const sendsBefore = sends;
      const first = await service.issue(input).then(
        () => { throw new Error("expected direct delivery to be rejected"); },
        (error: unknown) => error as { toJSON(): unknown },
      );
      expect(sends).toBe(sendsBefore + 1);
      expect(first.toJSON()).toMatchObject({ code: "PROVIDER_THROTTLED" });
      expect(await pool.query("select invalidated_at, terminal_error_code, delivery_acceptance_status from sms_kit.otp_challenge where subject_id = 'user-10'")).toMatchObject({ rows: [{ terminal_error_code: "PROVIDER_THROTTLED", delivery_acceptance_status: "rejected" }] });
      const replay = await service.issue(input).then(
        () => { throw new Error("expected terminal outcome to replay"); },
        (error: unknown) => error as { toJSON(): unknown },
      );

      expect(first.toJSON()).toEqual(replay.toJSON());
      expect(first.toJSON()).toMatchObject({ code: "PROVIDER_THROTTLED" });
    } finally {
      providerOutcome = "accepted";
    }
  });

  it("persists and replays a rate-limited terminal outcome without another dispatch", async () => {
    const firstInput = { tenantId: tenantA, subjectId: "user-11", action: "password.change" as const, phone: "13800138010", idempotencyKey: "user-11:password.change:first" };
    const limitedInput = { ...firstInput, idempotencyKey: "user-11:password.change:limited" };
    await service.issue(firstInput);
    const sendsBefore = sends;
    const first = await service.issue(limitedInput).then(
      () => { throw new Error("expected rate limiting"); },
      (error: unknown) => error as { toJSON(): unknown },
    );
    now = new Date("2026-09-13T03:00:00.000Z");
    const replay = await service.issue(limitedInput).then(
      () => { throw new Error("expected terminal outcome to replay"); },
      (error: unknown) => error as { toJSON(): unknown },
    );
    now = new Date("2026-09-13T02:00:00.000Z");

    expect(first.toJSON()).toEqual(replay.toJSON());
    expect(first.toJSON()).toMatchObject({ code: "RATE_LIMITED" });
    expect(sends).toBe(sendsBefore);
    expect((await pool.query("select terminal_error_code from sms_kit.otp_challenge where idempotency_key = $1", [limitedInput.idempotencyKey])).rows).toEqual([{ terminal_error_code: "RATE_LIMITED" }]);
  });

  it("uses one selected policy snapshot while retaining cooldown history for the supported maximum", async () => {
    const originalGet = store.policy.get.bind(store.policy);
    let reads = 0;
    store.policy.get = async (tx) => {
      const policy = await originalGet(tx);
      reads += 1;
      return reads === 2 ? { ...policy, phoneMinIntervalSeconds: 10 } : policy;
    };
    try {
      const issued = await service.issue({ tenantId: tenantA, subjectId: "user-12", action: "password.change", phone: "13800138011", idempotencyKey: "user-12:password.change:1" });
      const cooldown = await pool.query<{ seconds: string }>("select extract(epoch from expires_at - window_start)::text as seconds from sms_kit.rate_limit_bucket where scope_hash like '%challenge:auth.password_change'");

      expect(reads).toBe(2);
      expect(cooldown.rows).toContainEqual({ seconds: "3600.000000" });
      expect((await pool.query("select policy_version, otp_ttl_seconds from sms_kit.otp_challenge where id = $1", [issued.id])).rows).toEqual([{ policy_version: "1", otp_ttl_seconds: 300 }]);
    } finally {
      store.policy.get = originalGet;
    }
  });
});
