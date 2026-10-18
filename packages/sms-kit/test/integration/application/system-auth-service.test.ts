import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SystemAuthSmsService } from "../../../src/application/system-auth-service.js";
import type { MessageId, TenantId } from "../../../src/core/types.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { AesGcmPhoneNumberProtector } from "../../../src/security/aes-gcm-protector.js";
import { HmacHasher } from "../../../src/security/hmac-hasher.js";
import { startPostgres } from "../postgres/helpers.js";
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

describe("SYSTEM authentication persistence and budget", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let service: SystemAuthSmsService;
  let stop: (() => Promise<void>) | undefined;
  let sends = 0;
  let outcome: "accepted" | "rejected" | "unknown" = "accepted";
  const now = new Date("2026-09-29T12:00:00.000Z");
  const issue = (subjectId: string, phone = "13800138000") => service.issue({
    subjectId, action: "login.authenticate", phone, idempotencyKey: `issue:${subjectId}`,
  });

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: randomUUID(), externalKey: "system-signature", changeType: "new", checksum: "system-signature", resourceType: "signature", snapshot: { kind: "signature", externalName: "System", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: randomUUID(), externalKey: "system-template", changeType: "new", checksum: "system-template", resourceType: "template", signatureExternalKey: "system-signature", templateKey: "auth.login_otp", purpose: "auth.login_otp", snapshot: { kind: "template", externalCode: "SMS_SYSTEM_LOGIN", externalName: "Login", externalStatus: "approved", templateType: "verification", variableNames: ["code"] } });
    const preview = await store.resources.createSyncPreview({ id: randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await commitResourceFixturePreview(store, preview);
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: now, expectedVersion: config.version });
    const key = Buffer.alloc(32, 7);
    service = new SystemAuthSmsService({
      store,
      repository: store.systemAuth,
      provider: { send: async () => {
        sends += 1;
        if (outcome === "rejected") return { kind: "rejected", code: "isv.INVALID_PARAMETERS", retryable: false };
        if (outcome === "unknown") return { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
        return { kind: "accepted", bizId: `biz-${sends}`, requestId: `request-${sends}` };
      } } as never,
      phoneProtector: new AesGcmPhoneNumberProtector({ activeKey: async () => ({ id: "key-1", bytes: key }), keyById: async () => key }, new HmacHasher(Buffer.alloc(32, 8))),
      hasher: new HmacHasher(Buffer.alloc(32, 9)),
      clock: { now: () => now },
      ids: { next: randomUUID, messageId: () => randomUUID() as MessageId },
      providerTimeoutMs: 1_000,
      otpGenerator: { generate: () => "123456" },
    });
  }, 120_000);
  beforeEach(async () => {
    await pool.query("truncate sms_kit.otp_challenge, sms_kit.send_message, sms_kit.daily_send_budget, sms_kit.rate_limit_bucket cascade");
    const policy = await store.policy.get();
    await store.policy.update({ ...policy, expectedVersion: policy.version, systemDailyBudget: 1 });
    sends = 0;
    outcome = "accepted";
  });
  afterAll(async () => stop?.());

  it("serializes native sends against the shared daily budget before provider I/O", async () => {
    const results = await Promise.allSettled([issue("user-1"), issue("user-2", "13800138001")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(sends).toBe(1);
    expect((await pool.query("select scope_type, tenant_id from sms_kit.send_message")).rows)
      .toEqual([{ scope_type: "SYSTEM", tenant_id: null }]);
    expect((await pool.query("select held_count::int as held_count from sms_kit.daily_send_budget")).rows)
      .toEqual([{ held_count: 1 }]);
    expect((await pool.query("select count(*)::int as count from sms_kit.otp_challenge")).rows[0]?.count).toBe(1);
  });

  it("uses the same budget as TENANT sends without granting tenants SYSTEM ownership", async () => {
    const tenantId = "tenant-budget" as TenantId;
    const template = await store.resources.findTemplateByKey({ templateKey: "auth.login_otp" });
    const messageId = randomUUID() as MessageId;
    await pool.query(`insert into sms_kit.send_message
      (id, tenant_id, idempotency_key, template_id, template_key_snapshot, external_template_code_snapshot, signature_name_snapshot, purpose, variable_names, metadata, acceptance_status, delivery_status, submitted_at, created_at, updated_at)
      values ($1, $2, 'tenant-budget', $3, 'auth.login_otp', 'SMS_SYSTEM_LOGIN', 'System', 'auth.login_otp', '["code"]', '{}', 'pending', 'not_applicable', now(), now(), now())`, [messageId, tenantId, template!.id]);
    await store.transaction((tx) => store.policy.holdBudget({ tenantId, messageId, now }, tx));
    await expect(issue("user-1")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(sends).toBe(0);
    expect((await pool.query("select count(*)::int as count from sms_kit.otp_challenge")).rows[0]?.count).toBe(0);
  });

  it("releases a deterministic rejection and retains an unknown acceptance", async () => {
    outcome = "rejected";
    await expect(issue("rejected-user")).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
    expect((await pool.query("select held_count::int as held_count from sms_kit.daily_send_budget")).rows[0]?.held_count).toBe(0);
    expect((await pool.query("select state from sms_kit.send_budget_reservation")).rows).toEqual([{ state: "released" }]);
    outcome = "unknown";
    await expect(issue("unknown-user", "13800138001")).rejects.toMatchObject({ code: "ACCEPTANCE_UNKNOWN" });
    expect((await pool.query("select held_count::int as held_count from sms_kit.daily_send_budget")).rows[0]?.held_count).toBe(1);
    await expect(issue("blocked-user", "13800138002")).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(sends).toBe(2);
  });

  it("does not let a tenant release a SYSTEM reservation", async () => {
    await issue("user-1");
    const messageId = (await pool.query("select id from sms_kit.send_message")).rows[0].id as MessageId;
    expect(await store.transaction((tx) => store.policy.releaseBudget({ tenantId: "tenant-budget" as TenantId, messageId }, tx))).toBe(false);
    expect((await pool.query("select held_count::int as held_count from sms_kit.daily_send_budget")).rows[0]?.held_count).toBe(1);
  });

  it("rejects a verified proof after its challenge is invalidated", async () => {
    const issued = await issue("user-1");
    const verified = await service.verify({ subjectId: "user-1", action: "login.authenticate", challengeId: issued.id, code: "123456" });
    await store.transaction((tx) => store.systemAuth.invalidateActiveChallenges({ subjectId: "user-1", action: "login.authenticate", invalidatedAt: now }, tx));
    await expect(service.consumeProof({ subjectId: "user-1", action: "login.authenticate", proof: verified.proof, consumptionKey: "login:1" }))
      .rejects.toMatchObject({ code: "PROOF_INVALID" });
    expect((await pool.query("select consumed_at from sms_kit.otp_challenge where id = $1", [issued.id])).rows[0]?.consumed_at).toBeNull();
  });

  it("binds proofs to the subject and action and serializes one-time consumption", async () => {
    const issued = await issue("user-1");
    const verified = await service.verify({ subjectId: "user-1", action: "login.authenticate", challengeId: issued.id, code: "123456" });
    const consume = { subjectId: "user-1", action: "login.authenticate", proof: verified.proof, consumptionKey: "login:1" } as const;
    await expect(service.consumeProof({ ...consume, subjectId: "another-user" })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    await expect(service.consumeProof({ ...consume, action: "password.reset" })).rejects.toMatchObject({ code: "PROOF_INVALID" });
    const results = await Promise.allSettled([
      service.consumeProof(consume),
      service.consumeProof({ ...consume, consumptionKey: "login:2" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? "login:1" : "login:2";
    await expect(service.consumeProof({ ...consume, consumptionKey: winner })).resolves.toBe("replay");
  });
});
