import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SystemAuthSmsService } from "../../../src/application/system-auth-service.js";
import { DispatchRecoveryService } from "../../../src/application/dispatch-recovery-service.js";
import { ReceiptService } from "../../../src/application/receipt-service.js";
import { SystemAuthReconcileService } from "../../../src/application/system-auth-reconcile-service.js";
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
  let beforeSend: (() => Promise<void>) | undefined;
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
        await beforeSend?.();
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
    await pool.query("truncate sms_kit.otp_challenge, sms_kit.send_message, sms_kit.daily_send_budget, sms_kit.rate_limit_bucket, sms_kit.audit_event cascade");
    const policy = await store.policy.get();
    await store.policy.update({ ...policy, expectedVersion: policy.version, systemDailyBudget: 1 });
    sends = 0;
    outcome = "accepted";
    beforeSend = undefined;
  });
  afterAll(async () => stop?.());

  it("persists a durable SYSTEM attempt before provider I/O and completes it on acceptance", async () => {
    let beforeProvider: unknown;
    beforeSend = async () => {
      const { rows } = await pool.query(`select a.status, a.dispatch_mode, m.scope_type, m.tenant_id, m.acceptance_status
        from sms_kit.send_attempt a join sms_kit.send_message m on m.id = a.message_id`);
      beforeProvider = rows;
    };

    await issue("user-attempt");
    expect(beforeProvider).toEqual([{ status: "started", dispatch_mode: "direct", scope_type: "SYSTEM", tenant_id: null, acceptance_status: "pending" }]);
    const { rows } = await pool.query(`select a.status, a.dispatch_mode, m.scope_type, m.tenant_id, m.acceptance_status
      from sms_kit.send_attempt a join sms_kit.send_message m on m.id = a.message_id`);
    expect(rows).toEqual([{ status: "accepted", dispatch_mode: "direct", scope_type: "SYSTEM", tenant_id: null, acceptance_status: "accepted" }]);
    expect((await pool.query("select scope_type, tenant_id, action, result from sms_kit.audit_event where action = 'auth.sms.send'")).rows)
      .toEqual([{ scope_type: "SYSTEM", tenant_id: null, action: "auth.sms.send", result: "succeeded" }]);
    expect(sends).toBe(1);
  });

  it("recovers an abandoned SYSTEM attempt as unknown without resending", async () => {
    await issue("crashed-user");
    await pool.query("update sms_kit.send_attempt set status = 'started', dispatch_marked_at = $1 where status = 'accepted'", [new Date(now.getTime() - 60_000)]);
    await pool.query("update sms_kit.send_message set acceptance_status = 'pending', delivery_status = 'not_applicable', accepted_at = null where scope_type = 'SYSTEM'");
    await pool.query("update sms_kit.otp_challenge set delivery_acceptance_status = 'pending' where scope_type = 'SYSTEM'");

    const dependencies = { store, clock: { now: () => now }, systemAuth: store.systemAuth };
    const recovery = new DispatchRecoveryService(dependencies);
    expect(await recovery.runBatch({ limit: 10, abandonedBefore: now })).toBe(1);
    expect((await pool.query("select status from sms_kit.send_attempt")).rows).toEqual([{ status: "unknown" }]);
    expect((await pool.query("select acceptance_status from sms_kit.send_message")).rows).toEqual([{ acceptance_status: "unknown" }]);
    expect((await pool.query("select delivery_acceptance_status, invalidated_at is not null as invalidated from sms_kit.otp_challenge")).rows)
      .toEqual([{ delivery_acceptance_status: "unknown", invalidated: true }]);
    expect((await pool.query("select scope_type, tenant_id, action, result from sms_kit.audit_event where action = 'auth.sms.recover'")).rows)
      .toEqual([{ scope_type: "SYSTEM", tenant_id: null, action: "auth.sms.recover", result: "failed" }]);
    expect(await recovery.runBatch({ limit: 10, abandonedBefore: now })).toBe(0);
    expect(sends).toBe(1);
  });

  it("matches a SYSTEM delivery receipt by out-id and provider biz-id exactly once", async () => {
    await issue("receipt-user");
    const message = (await pool.query<{ id: string; provider_biz_id: string }>(
      "select id, provider_biz_id from sms_kit.send_message where scope_type = 'SYSTEM'",
    )).rows[0]!;
    const token = Buffer.alloc(32, 7).toString("base64url");
    const dependencies = {
      store,
      systemAuth: store.systemAuth,
      secrets: { resolve: async () => token },
      clock: { now: () => now },
      events: { emit: () => undefined },
    };
    const receipt = new ReceiptService(dependencies);
    const body = JSON.stringify([{ phone_number: "13800138000", biz_id: message.provider_biz_id,
      send_time: "2026-09-29 20:00:00", report_time: "2026-09-29 20:00:05",
      success: true, err_code: "DELIVERED", err_msg: "provider detail", sms_size: "1", out_id: message.id }]);
    const input = { token, body, deadlineAt: new Date(now.getTime() + 1_000) };

    await receipt.ingest(input);
    await receipt.ingest(input);
    expect((await pool.query("select scope_type, tenant_id, match_status, message_id from sms_kit.delivery_receipt")).rows)
      .toEqual([{ scope_type: "SYSTEM", tenant_id: null, match_status: "matched", message_id: message.id }]);
    expect((await pool.query("select delivery_status from sms_kit.send_message where id = $1", [message.id])).rows)
      .toEqual([{ delivery_status: "delivered" }]);
    let queried = false;
    const reconcile = new SystemAuthReconcileService({
      store, repository: store.systemAuth,
      provider: { queryDelivery: async () => { queried = true; throw new Error("terminal messages must not be queried"); } } as never,
      phoneProtector: { unprotect: async () => { throw new Error("terminal messages must not be decrypted"); } },
      clock: { now: () => now },
    });
    expect(await reconcile.runBatch({ limit: 1 })).toBe(1);
    expect(queried).toBe(false);
    expect((await pool.query("select state from sms_kit.send_job where message_id = $1 and job_type = 'reconcile'", [message.id])).rows)
      .toEqual([{ state: "succeeded" }]);
  });

  it("promotes a SYSTEM receipt that arrived before provider acceptance was saved", async () => {
    const token = Buffer.alloc(32, 7).toString("base64url");
    const receipt = new ReceiptService({
      store, systemAuth: store.systemAuth,
      secrets: { resolve: async () => token },
      clock: { now: () => now },
      events: { emit: () => undefined },
    });
    let callback: { token: string; body: string; deadlineAt: Date } | undefined;
    let earlyStatus: string | undefined;
    beforeSend = async () => {
      const messageId = (await pool.query<{ id: string }>("select id from sms_kit.send_message where scope_type = 'SYSTEM'")).rows[0]!.id;
      callback = { token, deadlineAt: new Date(now.getTime() + 1_000), body: JSON.stringify([{
        phone_number: "13800138000", biz_id: "biz-1", out_id: messageId,
        send_time: "2026-09-29 20:00:00", report_time: "2026-09-29 20:00:05",
        success: true, err_code: "DELIVERED", err_msg: "provider detail", sms_size: "1",
      }]) };
      await receipt.ingest(callback);
      earlyStatus = (await pool.query<{ match_status: string }>("select match_status from sms_kit.delivery_receipt")).rows[0]?.match_status;
    };

    await issue("early-receipt-user");
    expect(earlyStatus).toBe("unmatched");
    await receipt.ingest(callback!);
    expect((await pool.query("select scope_type, tenant_id, match_status from sms_kit.delivery_receipt")).rows)
      .toEqual([{ scope_type: "SYSTEM", tenant_id: null, match_status: "matched" }]);
    expect((await pool.query("select delivery_status from sms_kit.send_message")).rows)
      .toEqual([{ delivery_status: "delivered" }]);
    expect(sends).toBe(1);
  });

  it("schedules a SYSTEM reconciliation job after provider acceptance", async () => {
    await issue("reconcile-user");
    expect((await pool.query(`select j.scope_type, j.tenant_id, j.job_type, j.state, j.message_id
      from sms_kit.send_job j join sms_kit.send_message m on m.id = j.message_id
      where m.scope_type = 'SYSTEM'`)).rows)
      .toEqual([{ scope_type: "SYSTEM", tenant_id: null, job_type: "reconcile", state: "pending",
        message_id: (await pool.query("select id from sms_kit.send_message where scope_type = 'SYSTEM'")).rows[0]!.id }]);
  });

  it("queries an accepted SYSTEM message and records the authoritative delivery", async () => {
    await issue("query-user");
    const messageId = (await pool.query<{ id: string }>("select id from sms_kit.send_message where scope_type = 'SYSTEM'")).rows[0]!.id;
    const key = Buffer.alloc(32, 7);
    const queries: unknown[] = [];
    const dependencies = {
      store,
      repository: store.systemAuth,
      provider: { queryDelivery: async (input: unknown) => {
        queries.push(input);
        return { kind: "page" as const, items: [{ outId: messageId, status: "delivered" as const, occurredAt: now }], hasNextPage: false };
      } } as never,
      phoneProtector: new AesGcmPhoneNumberProtector({
        activeKey: async () => ({ id: "key-1", bytes: key }), keyById: async () => key,
      }, new HmacHasher(Buffer.alloc(32, 8))),
      clock: { now: () => now },
      events: { emit: () => undefined },
    };
    const reconcile = new SystemAuthReconcileService(dependencies);

    expect(await reconcile.runBatch({ limit: 10 })).toBe(1);
    expect(queries).toEqual([expect.objectContaining({ phoneNumber: "+8613800138000", sendDate: "20260929", bizId: "biz-1" })]);
    expect((await pool.query("select scope_type, tenant_id, source, message_id from sms_kit.delivery_receipt")).rows)
      .toEqual([{ scope_type: "SYSTEM", tenant_id: null, source: "query", message_id: messageId }]);
    expect((await pool.query("select delivery_status from sms_kit.send_message where id = $1", [messageId])).rows)
      .toEqual([{ delivery_status: "delivered" }]);
    expect((await pool.query("select state from sms_kit.send_job where message_id = $1 and job_type = 'reconcile'", [messageId])).rows)
      .toEqual([{ state: "succeeded" }]);
    expect(sends).toBe(1);
  });

  it("does not accept a query result for a different out-id and reschedules", async () => {
    await issue("query-mismatch-user");
    const key = Buffer.alloc(32, 7);
    const reconcile = new SystemAuthReconcileService({
      store, repository: store.systemAuth,
      provider: { queryDelivery: async () => ({ kind: "page", items: [{ outId: randomUUID(), status: "delivered" }], hasNextPage: false }) } as never,
      phoneProtector: new AesGcmPhoneNumberProtector({
        activeKey: async () => ({ id: "key-1", bytes: key }), keyById: async () => key,
      }, new HmacHasher(Buffer.alloc(32, 8))),
      clock: { now: () => now },
    });

    expect(await reconcile.runBatch({ limit: 1 })).toBe(1);
    expect((await pool.query("select acceptance_status, delivery_status from sms_kit.send_message")).rows)
      .toEqual([{ acceptance_status: "accepted", delivery_status: "waiting" }]);
    expect((await pool.query("select count(*)::int as count from sms_kit.delivery_receipt")).rows[0]?.count).toBe(0);
    expect((await pool.query("select state, last_error_code, available_at from sms_kit.send_job where job_type = 'reconcile'")).rows)
      .toEqual([{ state: "pending", last_error_code: "DELIVERY_UNKNOWN", available_at: new Date(now.getTime() + 5 * 60_000) }]);
  });

  it("finalizes a SYSTEM reconciliation after the provider query window expires without another send", async () => {
    await issue("query-expired-user");
    await pool.query("update sms_kit.send_attempt set dispatch_marked_at = $1 where status = 'accepted'", [new Date(now.getTime() - 31 * 24 * 60 * 60_000)]);
    let queried = false;
    const reconcile = new SystemAuthReconcileService({
      store, repository: store.systemAuth,
      provider: { queryDelivery: async () => { queried = true; throw new Error("query must not run"); } } as never,
      phoneProtector: { unprotect: async () => { throw new Error("decrypt must not run"); } },
      clock: { now: () => now },
    });

    expect(await reconcile.runBatch({ limit: 1 })).toBe(1);
    expect(queried).toBe(false);
    expect((await pool.query("select delivery_status, final_error_code from sms_kit.send_message")).rows)
      .toEqual([{ delivery_status: "unknown_final", final_error_code: "DELIVERY_UNKNOWN" }]);
    expect((await pool.query("select state from sms_kit.send_job where job_type = 'reconcile'")).rows)
      .toEqual([{ state: "succeeded" }]);
    expect(sends).toBe(1);
  });

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
    expect((await pool.query("select status, provider_code from sms_kit.send_attempt")).rows)
      .toEqual([{ status: "rejected", provider_code: "isv.INVALID_PARAMETERS" }]);
    expect((await pool.query("select held_count::int as held_count from sms_kit.daily_send_budget")).rows[0]?.held_count).toBe(0);
    expect((await pool.query("select state from sms_kit.send_budget_reservation")).rows).toEqual([{ state: "released" }]);
    outcome = "unknown";
    await expect(issue("unknown-user", "13800138001")).rejects.toMatchObject({ code: "ACCEPTANCE_UNKNOWN" });
    expect((await pool.query("select status from sms_kit.send_attempt order by status")).rows)
      .toEqual([{ status: "rejected" }, { status: "unknown" }]);
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
