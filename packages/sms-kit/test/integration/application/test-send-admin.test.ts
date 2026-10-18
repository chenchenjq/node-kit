import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { SendService } from "../../../src/application/send-service.js";
import { SendWorker } from "../../../src/application/send-worker.js";
import { AesGcmMessagePayloadProtector, AesGcmPhoneNumberProtector } from "../../../src/security/aes-gcm-protector.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { MessageId, TenantId } from "../../../src/core/types.js";
import { HmacHasher } from "../../../src/security/hmac-hasher.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

const actorA = { id: "test-send-admin-a", tenantId: "tenant-test-send-a" as TenantId } as AuthorizationActor;
const actorSameTenant = { id: "test-send-admin-a2", tenantId: actorA.tenantId } as AuthorizationActor;
const actorB = { id: "test-send-admin-b", tenantId: "tenant-test-send-b" as TenantId } as AuthorizationActor;
const now = new Date("2026-09-14T00:00:00.000Z");

describe("SendService administrative test send with PostgreSQL", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;
  let configurationVersion: number;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
  }, 120_000);

  afterAll(async () => stop?.());

  beforeEach(async () => {
    await pool.query(`truncate table
      sms_kit.admin_operation, sms_kit.audit_event, sms_kit.send_job, sms_kit.send_attempt,
      sms_kit.delivery_receipt, sms_kit.send_message, sms_kit.resource_sync_candidate,
      sms_kit.resource_sync, sms_kit.template, sms_kit.signature, sms_kit.provider_config cascade`);
    const configured = await store.config.update({
      provider: "aliyun", region: "cn-shanghai", endpoint: "https://sms.example.test",
      accessKeyIdRef: "env://SMS_TEST_ID", accessKeySecretRef: "env://SMS_TEST_SECRET",
      receiptCallbackTokenRef: "env://SMS_TEST_CALLBACK", enabled: true, expectedVersion: 0,
    });
    const ready = await store.config.recordConnectionTest({
      status: "succeeded", summary: { counts: [{ name: "signature", value: 1 }, { name: "template", value: 1 }] },
      testedAt: now, expectedVersion: configured.version,
    });
    configurationVersion = ready.version;
    const signature = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:sign:test-send", changeType: "new", checksum: "test-send-signature",
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: "Test send", externalStatus: "approved", externalType: "text",
      },
    });
    const template = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:template:SMS_TEST_SEND", changeType: "new", checksum: "test-send-template",
      resourceType: "template", signatureExternalKey: signature.externalKey,
      templateKey: "notice.test-send", purpose: "notification",
      snapshot: {
        kind: "template", externalCode: "SMS_TEST_SEND", externalName: "Test send notice",
        externalStatus: "approved", templateType: "notification", variableNames: ["secret"],
      },
    });
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template],
    });
    await commitResourceFixturePreview(store, preview, now);
  });

  function service(allowed = true, authorized = true): SendService {
    const fingerprinter = new HmacHasher(Buffer.alloc(32, 23));
    return new SendService({
      store,
      provider: {} as never,
      phoneProtector: {
        protect: async () => ({ ciphertext: "phone-ciphertext", keyId: "phone-key", lookupHash: "phone-hmac", last4: "8000", masked: "138****8000" }),
        unprotect: async () => { throw new Error("not used"); },
      },
      payloadProtector: {
        seal: async () => ({ ciphertext: "params-ciphertext", keyId: "params-key" }),
        open: async () => { throw new Error("not used"); },
      },
      clock: { now: () => now },
      ids: { next: () => randomUUID(), messageId: () => randomUUID() as MessageId },
      events: { emit: () => undefined },
      providerTimeoutMs: 1_000,
      testRecipientAllowlist: { allows: async () => allowed },
      testAuthorizer: { assert: () => {
        if (!authorized) throw new SmsKitError("PERMISSION_DENIED", "not allowed");
      } },
      testRequestFingerprinter: { fingerprint: (value) => fingerprinter.hash(value) },
    });
  }

  it("uses the queued pipeline once, replays safely, and never persists test plaintext in admin records", async () => {
    const input = {
      expectedVersion: configurationVersion,
      idempotencyKey: "test-send:one",
      phone: "13800138000",
      templateKey: "notice.test-send",
      variables: { secret: "TOP-SECRET-TEMPLATE-VALUE" },
      purpose: "notification",
    };
    const first = await service().enqueueTestNotification(actorA, input);
    // The system operation remains replayable only for the same trusted tenant fingerprint.
    const replay = await service(false).enqueueTestNotification(actorA, input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ templateKeySnapshot: "notice.test-send", acceptanceStatus: "pending", deliveryStatus: "not_applicable" });
    await expect(pool.query("select count(*)::integer as count from sms_kit.send_message where tenant_id = $1", [actorA.tenantId]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query("select count(*)::integer as count from sms_kit.send_job where tenant_id = $1", [actorA.tenantId]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query("select origin_action from sms_kit.send_job where tenant_id = $1", [actorA.tenantId]))
      .resolves.toMatchObject({ rows: [{ origin_action: "sms.test" }] });
    await expect(pool.query("select count(*)::integer as count from sms_kit.audit_event where tenant_id = $1 and action = 'sms.test.send'", [actorA.tenantId]))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query("select count(*)::integer as count from sms_kit.admin_operation where scope_type = 'SYSTEM' and tenant_id is null and operation = 'sms.test.send'"))
      .resolves.toMatchObject({ rows: [{ count: 1 }] });

    const persisted = await pool.query(`select
      (select coalesce(string_agg(result_snapshot::text, ''), '') from sms_kit.admin_operation) as operations,
      (select coalesce(string_agg(metadata::text, ''), '') from sms_kit.audit_event) as audits,
      (select coalesce(string_agg(concat_ws('|', idempotency_key, phone_ciphertext, phone_hash, render_params_ciphertext), ''), '') from sms_kit.send_message) as messages`);
    const serialized = JSON.stringify(persisted.rows[0]);
    expect(serialized).not.toContain("13800138000");
    expect(serialized).not.toContain("TOP-SECRET-TEMPLATE-VALUE");

    await expect(service().enqueueTestNotification(actorA, { ...input, variables: { secret: "different" } }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<SmsKitError>);
  });

  it("enforces the host recipient allowlist and configuration version fence before creating a message", async () => {
    const input = {
      expectedVersion: configurationVersion,
      idempotencyKey: "test-send:guarded",
      phone: "13800138000",
      templateKey: "notice.test-send",
      variables: { secret: "value" },
      purpose: "notification",
    };
    await expect(service(false).enqueueTestNotification(actorA, input))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" } satisfies Partial<SmsKitError>);
    await expect(service(true, false).enqueueTestNotification(actorA, { ...input, idempotencyKey: "test-send:no-sms-test" }))
      .rejects.toMatchObject({ code: "PERMISSION_DENIED" } satisfies Partial<SmsKitError>);
    await expect(service().enqueueTestNotification(actorA, { ...input, expectedVersion: configurationVersion - 1, idempotencyKey: "test-send:stale" }))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    await expect(pool.query("select count(*)::integer as count from sms_kit.send_message"))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rejects reuse of a global operation key with another tenant fingerprint while keeping messages tenant-owned", async () => {
    const input = {
      expectedVersion: configurationVersion,
      idempotencyKey: "test-send:tenant-scope",
      phone: "13800138000",
      templateKey: "notice.test-send",
      variables: { secret: "value" },
      purpose: "notification",
    };
    const first = await service().enqueueTestNotification(actorA, input);
    const sameTenantReplay = await service(false).enqueueTestNotification(actorSameTenant, input);
    await expect(service().enqueueTestNotification(actorB, input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const second = await service().enqueueTestNotification(actorB, { ...input, idempotencyKey: "test-send:other-operation" });

    expect(sameTenantReplay).toEqual(first);
    expect(second.id).not.toBe(first.id);
    await expect(pool.query("select tenant_id, count(*)::integer as count from sms_kit.send_message group by tenant_id order by tenant_id"))
      .resolves.toMatchObject({ rows: [{ tenant_id: actorA.tenantId, count: 1 }, { tenant_id: actorB.tenantId, count: 1 }] });
  });

  it("dispatches an allowlisted verification test through the durable pipeline without an authentication proof", async () => {
    await pool.query(`update sms_kit.template set template_key = 'auth.login_otp', purpose = 'auth.login_otp',
      template_type = 'verification', variable_schema = '["code"]' where template_key = 'notice.test-send'`);
    const key = Buffer.alloc(32, 7);
    const keyring = { activeKey: async () => ({ id: "test-key", bytes: key }), keyById: async () => key };
    const phoneProtector = new AesGcmPhoneNumberProtector(keyring, new HmacHasher(Buffer.alloc(32, 8)));
    const payloadProtector = new AesGcmMessagePayloadProtector(keyring);
    const calls: unknown[] = [];
    const provider = { send: async (input: unknown) => {
      calls.push(input);
      return { kind: "accepted", bizId: "test-biz", requestId: "test-request" };
    } } as never;
    const clock = { now: () => now };
    const fingerprinter = new HmacHasher(Buffer.alloc(32, 23));
    const sender = new SendService({
      store, provider, phoneProtector, payloadProtector, clock,
      ids: { next: randomUUID, messageId: () => randomUUID() as MessageId },
      events: { emit: () => undefined }, providerTimeoutMs: 1_000,
      testRecipientAllowlist: { allows: async () => true },
      testAuthorizer: { assert: () => undefined },
      testRequestFingerprinter: { fingerprint: (value) => fingerprinter.hash(value) },
    });
    const input = { expectedVersion: configurationVersion, idempotencyKey: "verification-test", phone: "13800138000", templateKey: "auth.login_otp", purpose: "auth.login_otp", variables: { code: "123456" } };
    const message = await sender.enqueueTestNotification(actorA, input);
    const worker = new SendWorker({ store, provider, phoneProtector, payloadProtector, clock });
    expect(await worker.runBatch({ workerId: "test-worker", limit: 1, leaseMs: 30_000, providerTimeoutMs: 1_000 })).toBe(1);
    await expect(sender.enqueueTestNotification(actorA, input)).resolves.toMatchObject({ id: message.id });
    expect(await worker.runBatch({ workerId: "test-worker", limit: 1, leaseMs: 30_000, providerTimeoutMs: 1_000 })).toBe(0);
    expect(calls).toEqual([expect.objectContaining({ phoneNumber: "+8613800138000", templateParams: { code: "123456" }, outId: message.id })]);
    expect((await pool.query("select count(*)::int as count from sms_kit.otp_challenge")).rows).toEqual([{ count: 0 }]);
    expect((await pool.query("select status from sms_kit.send_attempt where message_id = $1", [message.id])).rows).toEqual([{ status: "accepted" }]);
    expect((await pool.query("select acceptance_status from sms_kit.send_message where id = $1", [message.id])).rows).toEqual([{ acceptance_status: "accepted" }]);
  });

  it("keeps verification tests behind the recipient guard and rejects them as ordinary notification jobs", async () => {
    await pool.query(`update sms_kit.template set template_key = 'auth.login_otp', purpose = 'auth.login_otp',
      template_type = 'verification', variable_schema = '["code"]' where template_key = 'notice.test-send'`);
    const input = { expectedVersion: configurationVersion, idempotencyKey: "verification-guard", phone: "13800138000", templateKey: "auth.login_otp", purpose: "auth.login_otp", variables: { code: "123456" } };
    await expect(service(false).enqueueTestNotification(actorA, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(service().enqueueNotification({ ...input, tenantId: actorA.tenantId })).rejects.toMatchObject({ code: "TEMPLATE_UNAVAILABLE" });
    expect((await pool.query("select count(*)::int as count from sms_kit.send_message")).rows).toEqual([{ count: 0 }]);
  });
});
