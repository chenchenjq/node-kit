import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { HealthService } from "../../../src/application/health-service.js";
import { PolicyService } from "../../../src/application/policy-service.js";
import { ReconcileAdminService } from "../../../src/application/reconcile-admin-service.js";
import { SendService } from "../../../src/application/send-service.js";
import { SendWorker } from "../../../src/application/send-worker.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { MessageId, TenantId, TemplateId } from "../../../src/core/types.js";
import { createSmsAdminHandler } from "../../../src/next/index.js";
import { operationJobAuthorization, operationsRoute } from "../../../src/next/handlers/operations.js";
import type { SmsProvider } from "../../../src/ports/provider.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const now = new Date("2026-09-14T12:00:00.000Z");
const tenantA = "tenant-operations-a" as TenantId;
const tenantB = "tenant-operations-b" as TenantId;
const fullPhone = "+8613800138000";

const adminA = {
  id: "admin-operations-a",
  tenantId: tenantA,
  permissions: ["config.read", "config.write", "message.read", "stats.read", "receipt.reconcile", "sms.test"],
} as const satisfies AuthorizationActor;
const adminB = {
  id: "admin-operations-b",
  tenantId: tenantB,
  permissions: ["config.read", "config.write", "message.read", "stats.read", "receipt.reconcile", "sms.test"],
} as const satisfies AuthorizationActor;
const messageReaderA = {
  id: "reader-operations-a",
  tenantId: tenantA,
  permissions: ["message.read", "stats.read"],
} as const satisfies AuthorizationActor;
const receiptReconcilerA = {
  id: "reconciler-operations-a",
  tenantId: tenantA,
  permissions: ["receipt.reconcile"],
} as const satisfies AuthorizationActor;
const testSenderA = {
  id: "test-sender-operations-a",
  tenantId: tenantA,
  permissions: ["sms.test"],
} as const satisfies AuthorizationActor;

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const authorizer = {
  assert: (actor: AuthorizationActor, action: string) => {
    if (!(actor.permissions ?? []).includes(action)) throw new SmsKitError("PERMISSION_DENIED", "not allowed");
  },
  assertAny: (actor: AuthorizationActor, actions: readonly string[]) => {
    if (!actions.some((action) => (actor.permissions ?? []).includes(action))) {
      throw new SmsKitError("PERMISSION_DENIED", "not allowed");
    }
  },
};

describe("sms operations routes with PostgreSQL", () => {
  let stop: (() => Promise<void>) | undefined;
  let store: PgSmsStore;
  let pool: Pool;
  let policy: PolicyService<AuthorizationActor>;
  let health: HealthService;
  let templateId: TemplateId;
  const phoneHashCalls: string[] = [];
  const phoneProtector = {
    lookupHash: async (phone: string) => {
      phoneHashCalls.push(phone);
      return `lookup:${phone}`;
    },
  };

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    pool = postgres.pool;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    const signatureId = randomUUID();
    templateId = randomUUID() as TemplateId;
    await pool.query(
      `insert into sms_kit.signature (
         id, external_key, external_name, external_status, external_type,
         enabled, imported_at, last_synced_at, created_at, updated_at
       ) values ($1, $2, $3, 'approved', 'normal', true, $4, $4, $4, $4)`,
      [signatureId, `operations-signature:${signatureId}`, "Operations", now],
    );
    await pool.query(
      `insert into sms_kit.template (
         id, signature_id, template_key, external_code, external_name,
         external_status, template_type, purpose, content_snapshot,
         variable_schema, enabled, imported_at, last_synced_at, created_at, updated_at
       ) values ($1, $2, 'notice.operations', $3, 'Operations', 'approved',
         'notification', 'notification', 'fixture', '[]'::jsonb, true, $4, $4, $4, $4)`,
      [templateId, signatureId, `SMS_OPERATIONS_${signatureId.replaceAll("-", "")}`, now],
    );
    policy = new PolicyService({
      store,
      authorizer,
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
    });
    health = new HealthService({ store, clock: { now: () => now } });
  }, 120_000);

  afterAll(async () => stop?.());

  function handler(actor: AuthorizationActor) {
    return createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.10",
      authorizer,
      services: {
        task4: {
          store,
          policy,
          health,
          reconcile: new ReconcileAdminService({ store, authorizer, clock: { now: () => now }, ids: { next: () => randomUUID() } }),
          phoneProtector,
          clock: { now: () => now },
          betterAuth: {
            get: async () => ({
              adapterStatus: "enabled" as const,
              loginTemplateKey: "auth.login_otp",
              passwordResetTemplateKey: "auth.password_reset",
            }),
          },
        },
      },
      ids: { next: () => randomUUID(), messageId: () => randomUUID() as MessageId },
    });
  }

  async function request(actor: AuthorizationActor, path: string, method = "GET", body?: unknown): Promise<Response> {
    return handler(actor)(new Request(`https://app.test/api/admin/sms${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }));
  }

  async function seedMessage(input: Readonly<{
    tenantId: TenantId;
    idempotencyKey: string;
    acceptanceStatus: "accepted" | "unknown";
    deliveryStatus: "waiting" | "delivered";
    providerBizId: string;
    attemptCount: number;
    templateKey?: string;
    purpose?: string;
    submittedAt?: Date;
  }>): Promise<MessageId> {
    const id = randomUUID() as MessageId;
    const submittedAt = input.submittedAt ?? now;
    const created = await store.messages.createWithSendJob({
      id,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      templateId,
      templateKeySnapshot: input.templateKey ?? "notice.operations",
      externalTemplateCodeSnapshot: "SMS_OPERATIONS",
      signatureNameSnapshot: "Operations",
      purpose: input.purpose ?? "notification",
      phoneCiphertext: "ciphertext:never-returned",
      phoneKeyId: "phone-key-1",
      phoneHash: `lookup:${fullPhone}`,
      phoneLast4: "8000",
      phoneMasked: "138****8000",
      variableNames: ["orderNo"],
      renderParamsCiphertext: "variables:never-returned",
      renderParamsKeyId: "params-key-1",
      metadata: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] },
      submittedAt,
    });
    expect(created.created).toBe(true);

    // The repository owns tenancy/row projection; this fixture only advances
    // the seeded message into an operational state the admin handler can read.
    await pool.query(
      `update sms_kit.send_message
          set acceptance_status = $1,
              delivery_status = $2,
              provider_biz_id = $3,
              provider_request_id = $7,
              accepted_at = $4::timestamptz,
              delivered_at = case when $2::text = 'delivered' then $4::timestamptz else null end,
              version = 1
        where tenant_id = $5 and id = $6`,
      [input.acceptanceStatus, input.deliveryStatus, input.providerBizId, submittedAt, input.tenantId, id, `request:${input.providerBizId}`],
    );
    for (let attemptNo = 1; attemptNo <= input.attemptCount; attemptNo += 1) {
      await pool.query(
        `insert into sms_kit.send_attempt (
           id, message_id, attempt_no, status, dispatch_mode, dispatch_token,
           dispatch_marked_at, provider_request_id, provider_code, error_code,
           latency_ms, occurred_at
         ) values ($1, $2, $3, $4, 'direct', $5, $6, $7, $8, $9, $10, $6)`,
        [
          randomUUID(), id, attemptNo, attemptNo === input.attemptCount ? "accepted" : "rejected",
          randomUUID(), submittedAt, `attempt-request:${input.providerBizId}:${attemptNo}`,
          attemptNo === input.attemptCount ? "OK" : "isv.BUSINESS_LIMIT_CONTROL",
          attemptNo === input.attemptCount ? null : "PROVIDER_THROTTLED",
          40 + attemptNo,
        ],
      );
    }
    return id;
  }

  it("keeps message, receipt-health, and statistics reads tenant-scoped, explicit, and redacted", async () => {
    const messageA = await seedMessage({
      tenantId: tenantA,
      idempotencyKey: `operations-read-a:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "waiting",
      providerBizId: "biz-operations-a",
      attemptCount: 2,
    });
    const messageB = await seedMessage({
      tenantId: tenantB,
      idempotencyKey: `operations-read-b:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "delivered",
      providerBizId: "biz-operations-b",
      attemptCount: 1,
    });
    // Snapshots and provider identifiers predate the bounded *request* input
    // contract. Their response DTOs must remain able to render valid legacy
    // rows rather than turning a read into a 500.
    const legacyTemplateKey = `legacy.${"k".repeat(300)}`;
    const legacyProviderBizId = "b".repeat(300);
    const legacyMessageA = await seedMessage({
      tenantId: tenantA,
      idempotencyKey: `operations-read-a-legacy:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "waiting",
      providerBizId: legacyProviderBizId,
      attemptCount: 1,
      templateKey: legacyTemplateKey,
    });
    await seedMessage({
      tenantId: tenantA,
      idempotencyKey: `operations-read-a-old:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "waiting",
      providerBizId: "biz-operations-a-old",
      attemptCount: 1,
      submittedAt: new Date("2026-09-12T12:00:00.000Z"),
    });
    await seedMessage({
      tenantId: tenantA,
      idempotencyKey: `operations-read-a-delivered:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "delivered",
      providerBizId: "biz-operations-a-delivered",
      attemptCount: 1,
    });
    await pool.query(
      `insert into sms_kit.daily_stat (
         tenant_id, stat_date, template_id, template_key, purpose,
         submitted_count, accepted_count, acceptance_rejected_count,
         acceptance_unknown_count, delivery_waiting_count, delivered_count,
         delivery_failed_count, delivery_unknown_final_count, retry_count, updated_at
       ) values
         ($1, '2026-09-14', $3, 'notice.operations', 'notification', 8, 4, 2, 2, 1, 2, 1, 0, 3, $4),
         ($1, '2026-09-14', $3, 'notice.operations', 'verification', 7, 7, 0, 0, 0, 7, 0, 0, 0, $4),
         ($1, '2026-09-14', $3, 'notice.other', 'notification', 99, 99, 0, 0, 0, 99, 0, 0, 0, $4),
         ($1, '2026-09-14', $3, 'notice.large', 'notification', 9007199254740992, 9007199254740991, 0, 0, 0, 0, 0, 0, 0, $4),
         ($2, '2026-09-14', $3, 'notice.operations', 'notification', 50, 50, 0, 0, 0, 50, 0, 0, 0, $4)`,
      [tenantA, tenantB, templateId, now],
    );
    await pool.query(
      `insert into sms_kit.delivery_receipt (
         id, message_id, tenant_id, match_status, dedupe_key, provider_out_id,
         delivery_status, occurred_at, received_at, source, redacted_payload
       ) values ($1, null, null, 'unmatched', $2, $3, 'failed', $4, $4, 'callback', '{"redactedFields":["phone"]}'::jsonb)`,
      [randomUUID(), `unmatched:${randomUUID()}`, `unmatched-out:${randomUUID()}`, now],
    );
    await pool.query(
      `insert into sms_kit.delivery_receipt (
         id, message_id, tenant_id, match_status, dedupe_key, provider_biz_id,
         provider_out_id, delivery_status, provider_code, provider_message,
         occurred_at, received_at, source, redacted_payload
       ) values ($1, $2, $3, 'matched', $4, 'biz-operations-a', $6, 'delivered',
         'DELIVERED', 'provider payload must not escape', $5, $5, 'callback',
         '{"redactedFields":["phone","template-params"],"reportCount":1,"rawPhone":"+8613800138000"}'::jsonb)`,
      [randomUUID(), messageA, tenantA, `matched:${randomUUID()}`, now, messageA],
    );

    phoneHashCalls.length = 0;
    const listed = await request(
      adminA,
      `/messages?page=1&pageSize=20&from=2026-09-14T00%3A00%3A00.000Z&to=2026-09-15T00%3A00%3A00.000Z&acceptanceStatus=accepted&deliveryStatus=waiting&templateKey=notice.operations&purpose=notification&phone=${encodeURIComponent(fullPhone)}`,
    );
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.data).toMatchObject({
      page: 1,
      pageSize: 20,
      total: 1,
      items: [{
        id: messageA,
        acceptanceStatus: "accepted",
        deliveryStatus: "waiting",
        attemptCount: 2,
        phone: { masked: "138****8000", last4Available: true },
      }],
    });
    expect(phoneHashCalls).toEqual([fullPhone]);
    expect(JSON.stringify(listBody)).not.toContain("13800138000");
    expect(JSON.stringify(listBody)).not.toContain("ciphertext:never-returned");
    expect(JSON.stringify(listBody)).not.toContain("variables:never-returned");

    const detail = await request(adminA, `/messages/${messageA}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({ data: {
      id: messageA,
      acceptedAt: now.toISOString(),
      attemptCount: 2,
      providerRequestId: "request:biz-operations-a",
      attempts: [
        {
          attemptNo: 1,
          status: "rejected",
          dispatchMode: "direct",
          providerRequestId: "attempt-request:biz-operations-a:1",
          errorCode: "PROVIDER_THROTTLED",
          latencyMs: 41,
        },
        {
          attemptNo: 2,
          status: "accepted",
          dispatchMode: "direct",
          providerRequestId: "attempt-request:biz-operations-a:2",
          latencyMs: 42,
        },
      ],
      receipts: [{
        source: "callback",
        deliveryStatus: "delivered",
        diagnostics: { redactedFields: ["phone", "template-params"], reportCount: 1 },
      }],
      diagnostics: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] },
    } });
    const serializedDetail = JSON.stringify(detailBody);
    for (const forbidden of [
      "ciphertext:never-returned",
      "variables:never-returned",
      "+8613800138000",
      "provider payload must not escape",
      "rawPhone",
      "dispatchToken",
      "leaseToken",
      "orderNo",
    ]) expect(serializedDetail).not.toContain(forbidden);
    const legacyDetail = await request(adminA, `/messages/${legacyMessageA}`);
    expect(legacyDetail.status).toBe(200);
    expect(await legacyDetail.json()).toMatchObject({ data: {
      id: legacyMessageA,
      templateKey: legacyTemplateKey,
      providerBizId: legacyProviderBizId,
    } });
    expect((await request(adminA, `/messages/${messageB}`)).status).toBe(404);
    expect((await request(adminA, "/messages/not-a-postgres-uuid")).status).toBe(404);
    expect((await request(adminA, "/messages?from=2026-09-14T00%3A00%3A00.000Z")).status).toBe(400);
    const oversizedTemplateKey = "a".repeat(257);
    expect((await request(adminA, `/messages?templateKey=${oversizedTemplateKey}`)).status).toBe(400);

    const stats = await request(adminA, "/stats?from=2026-09-14T00%3A00%3A00.000Z&to=2026-09-15T00%3A00%3A00.000Z&templateKey=notice.operations&purpose=notification");
    expect(stats.status).toBe(200);
    expect(await stats.json()).toMatchObject({ data: {
      submitted: 8,
      accepted: 4,
      acceptanceRejected: 2,
      acceptanceUnknown: 2,
      deliveryWaiting: 1,
      delivered: 2,
      deliveryFailed: 1,
      deliveryUnknownFinal: 0,
      retry: 3,
      acceptanceRate: 0.5,
      deliveryRate: 0.5,
    } });
    const statusFilteredStats = await request(adminA, "/stats?from=2026-09-14T00%3A00%3A00.000Z&to=2026-09-15T00%3A00%3A00.000Z&templateKey=notice.operations&purpose=notification&acceptanceStatus=accepted&deliveryStatus=waiting");
    expect(statusFilteredStats.status).toBe(200);
    expect(await statusFilteredStats.json()).toMatchObject({ data: {
      submitted: 1,
      accepted: 1,
      acceptanceRejected: 0,
      acceptanceUnknown: 0,
      deliveryWaiting: 1,
      delivered: 0,
      deliveryFailed: 0,
      deliveryUnknownFinal: 0,
      retry: 1,
      acceptanceRate: 1,
      deliveryRate: 0,
    } });
    const largeStats = await request(adminA, "/stats?from=2026-09-14T00%3A00%3A00.000Z&to=2026-09-15T00%3A00%3A00.000Z&templateKey=notice.large&purpose=notification");
    expect(largeStats.status).toBe(200);
    expect(await largeStats.json()).toMatchObject({ data: {
      submitted: "9007199254740992",
      accepted: 9007199254740991,
      acceptanceRate: 0.999999999999,
    } });
    expect((await request(adminA, "/stats?from=2025-01-01T00%3A00%3A00.000Z&to=2026-09-14T00%3A00%3A00.000Z")).status).toBe(400);
    expect((await request(adminA, "/stats?from=2026-09-14T12%3A00%3A00.000Z&to=2026-09-15T12%3A00%3A00.000Z")).status).toBe(400);
    expect((await request(adminA, `/stats?templateKey=${oversizedTemplateKey}`)).status).toBe(400);

    const receiptHealth = await request(adminA, "/receipt-health");
    expect(receiptHealth.status).toBe(200);
    expect(await receiptHealth.json()).toMatchObject({ data: { unmatchedCount: 1, systemBudgetRemaining: null, circuitOpen: false } });
  });

  it("replays versioned policy and reconciliation writes without changing provider readiness and gates jobs by their originating action", async () => {
    const current = await store.policy.get();
    const verification = await request(adminA, "/verification");
    expect(verification.status).toBe(200);
    expect(await verification.json()).toMatchObject({ data: {
      version: current.version,
      circuitOpen: false,
      betterAuth: {
        adapterStatus: "enabled",
        loginTemplateKey: "auth.login_otp",
        passwordResetTemplateKey: "auth.password_reset",
      },
    } });
    const configured = await store.config.update({
      provider: "aliyun",
      region: "cn-shanghai",
      accessKeyIdRef: "env://OPERATIONS_ACCESS_KEY_ID",
      accessKeySecretRef: "env://OPERATIONS_ACCESS_KEY_SECRET",
      receiptCallbackTokenRef: "env://OPERATIONS_RECEIPT_TOKEN",
      enabled: true,
      expectedVersion: 0,
    });
    const readyConfig = await store.config.recordConnectionTest({
      expectedVersion: configured.version,
      status: "succeeded",
      summary: {},
      testedAt: now,
    });
    const acceptedProvider = {
      testConnection: async () => ({ status: "ready", signatureCount: 1, templateCount: 1 }),
      listSignatures: async () => ({ items: [] }),
      listTemplates: async () => ({ items: [] }),
      send: async () => ({ kind: "accepted", bizId: "biz-automatic-reconcile", requestId: "request-automatic-reconcile" }),
      queryDelivery: async () => ({ kind: "page", items: [], hasNextPage: false }),
      parseReceipt: () => ({ items: [], acknowledgement: { code: 0, msg: "OK" } }),
    } as const satisfies SmsProvider;
    const sendPhoneProtector = {
      protect: async () => ({
        ciphertext: "automatic-phone-ciphertext",
        keyId: "automatic-phone-key",
        lookupHash: `lookup:${fullPhone}`,
        masked: "138****8000",
        last4: "8000",
      }),
      unprotect: async () => fullPhone as never,
    };
    const sendPayloadProtector = {
      seal: async () => ({ ciphertext: "automatic-params-ciphertext", keyId: "automatic-params-key" }),
      open: async () => ({}),
    };
    const send = new SendService({
      store,
      provider: acceptedProvider,
      phoneProtector: sendPhoneProtector,
      payloadProtector: sendPayloadProtector,
      clock: { now: () => now },
      ids: { next: () => randomUUID(), messageId: () => randomUUID() as MessageId },
      events: { emit: () => undefined },
      providerTimeoutMs: 1_000,
    });
    const automaticallyScheduled = await send.enqueueNotification({
      tenantId: tenantA,
      templateKey: "notice.operations",
      phone: fullPhone,
      variables: {},
      purpose: "notification",
      idempotencyKey: `operations-automatic-reconcile:${randomUUID()}`,
    });
    await expect(new SendWorker({
      store,
      provider: acceptedProvider,
      phoneProtector: sendPhoneProtector,
      payloadProtector: sendPayloadProtector,
      clock: { now: () => now },
    }).runBatch({ workerId: "operations-send-worker", limit: 1, leaseMs: 60_000, providerTimeoutMs: 1_000 })).resolves.toBe(1);
    const automaticallyScheduledMessage = automaticallyScheduled.id;
    const automaticJobRow = await pool.query<{ id: string }>(
      "select id from sms_kit.send_job where tenant_id = $1 and message_id = $2 and job_type = 'reconcile'",
      [tenantA, automaticallyScheduledMessage],
    );
    const automaticJob = await store.jobs.get({ tenantId: tenantA, id: automaticJobRow.rows[0]!.id });
    expect(automaticJob).toBeDefined();
    if (automaticJob === undefined) throw new Error("expected automatic reconciliation job");
    const automaticMessage = await store.messages.get({ tenantId: tenantA, id: automaticallyScheduledMessage });
    expect(automaticMessage).toMatchObject({ acceptanceStatus: "accepted", deliveryStatus: "waiting" });
    if (automaticMessage === undefined) throw new Error("expected automatically accepted message");

    const policyPatch = {
      version: current.version,
      idempotencyKey: `verification:open:${randomUUID()}`,
      otpLength: 6,
      otpTtlSeconds: 300,
      otpMaxAttempts: 3,
      proofTtlSeconds: 300,
      phoneMinIntervalSeconds: 60,
      phoneHourlyLimit: 5,
      phoneDailyLimit: 10,
      ipWindowSeconds: 600,
      ipWindowLimit: 20,
      systemDailyBudget: 500,
      circuitOpen: true,
      circuitReason: "provider incident",
    };
    const updated = await request(adminA, "/verification", "PATCH", policyPatch);
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ data: {
      version: current.version + 1,
      systemDailyBudget: 500,
      circuitOpen: true,
      betterAuth: { adapterStatus: "enabled", loginTemplateKey: "auth.login_otp", passwordResetTemplateKey: "auth.password_reset" },
    } });
    const replayed = await request(adminA, "/verification", "PATCH", policyPatch);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ data: { version: current.version + 1, circuitOpen: true } });
    // Idempotency records are tenant-scoped: another tenant cannot replay the
    // first tenant's policy result merely by knowing its key and request body.
    expect((await request(adminB, "/verification", "PATCH", policyPatch)).status).toBe(409);
    expect(await store.config.get()).toMatchObject({ status: "ready", version: readyConfig.version });

    const messageA = await seedMessage({
      tenantId: tenantA,
      idempotencyKey: `operations-reconcile-a:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "waiting",
      providerBizId: "biz-reconcile-a",
      attemptCount: 1,
    });
    const messageDetail = await request(adminA, `/messages/${messageA}`);
    expect(messageDetail.status).toBe(200);
    const detailBody = await messageDetail.json();
    expect(detailBody.data.version).toBe(1);

    const reconcileInput = {
      version: detailBody.data.version,
      idempotencyKey: `reconcile:${messageA}`,
      messageId: messageA,
      providerBizId: "biz-reconcile-a",
    };
    const scheduled = await request(adminA, "/reconcile", "POST", reconcileInput);
    expect(scheduled.status).toBe(200);
    const scheduledBody = await scheduled.json();
    expect(scheduledBody.data).toMatchObject({
      jobType: "reconcile",
      state: "pending",
      messageId: messageA,
      attemptCount: 0,
    });
    const replay = await request(adminA, "/reconcile", "POST", reconcileInput);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data.id).toBe(scheduledBody.data.id);
    expect((await request(adminB, "/reconcile", "POST", reconcileInput)).status).toBe(404);
    expect((await request(adminA, "/reconcile", "POST", {
      version: detailBody.data.version,
      idempotencyKey: `reconcile:missing-target:${randomUUID()}`,
    })).status).toBe(400);
    expect((await request(adminA, "/reconcile", "POST", {
      version: detailBody.data.version,
      idempotencyKey: `reconcile:invalid-target:${randomUUID()}`,
      messageId: "not-a-postgres-uuid",
    })).status).toBe(404);
    const oversizedBizId = "b".repeat(129);
    expect((await request(adminA, "/reconcile", "POST", {
      version: detailBody.data.version,
      idempotencyKey: `reconcile:oversized-biz:${randomUUID()}`,
      providerBizId: oversizedBizId,
    })).status).toBe(400);
    await expect(new ReconcileAdminService({ store, authorizer, clock: { now: () => now }, ids: { next: () => randomUUID() } }).enqueue(adminA, {
      expectedVersion: detailBody.data.version,
      idempotencyKey: `reconcile:direct-oversized-biz:${randomUUID()}`,
      providerBizId: oversizedBizId,
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" } satisfies Partial<SmsKitError>);

    expect((await request(messageReaderA, `/jobs/${scheduledBody.data.id}`)).status).toBe(403);
    expect((await request(receiptReconcilerA, `/jobs/${scheduledBody.data.id}`)).status).toBe(200);
    const job = await request(adminA, `/jobs/${scheduledBody.data.id}`);
    expect(job.status).toBe(200);
    expect(await job.json()).toMatchObject({ data: { id: scheduledBody.data.id, jobType: "reconcile" } });
    expect((await request(adminB, `/jobs/${scheduledBody.data.id}`)).status).toBe(404);
    expect((await request(adminA, "/jobs/not-a-postgres-uuid")).status).toBe(404);

    const testOriginJobId = randomUUID();
    await pool.query(
      `insert into sms_kit.send_job (
         id, tenant_id, dedupe_key, job_type, message_id, state, available_at,
         attempt_count, max_attempts, origin_action, payload, created_at, updated_at
       ) values ($1, $2, $3, 'send', $4, 'succeeded', $5, 0, 3, 'sms.test', '{"kind":"none"}'::jsonb, $5, $5)`,
      [testOriginJobId, tenantA, `operations-sms-test:${randomUUID()}`, messageA, now],
    );
    expect((await request(receiptReconcilerA, `/jobs/${testOriginJobId}`)).status).toBe(403);
    const testOriginJob = await request(testSenderA, `/jobs/${testOriginJobId}`);
    expect(testOriginJob.status).toBe(200);
    expect(JSON.stringify(await testOriginJob.json())).not.toContain("originAction");

    expect(automaticJob.originAction).toBeUndefined();
    expect((await request(receiptReconcilerA, "/reconcile", "POST", {
      version: automaticMessage.version + 1,
      idempotencyKey: `reconcile:stale:${automaticallyScheduledMessage}`,
      messageId: automaticallyScheduledMessage,
    })).status).toBe(409);
    const automaticReconcileInput = {
      version: automaticMessage.version,
      idempotencyKey: `reconcile:existing:${automaticallyScheduledMessage}`,
      messageId: automaticallyScheduledMessage,
    };
    const manuallyRequestedExisting = await request(receiptReconcilerA, "/reconcile", "POST", automaticReconcileInput);
    expect(manuallyRequestedExisting.status).toBe(200);
    expect((await manuallyRequestedExisting.json()).data.id).toBe(automaticJob.id);
    const automaticReplay = await request(receiptReconcilerA, "/reconcile", "POST", automaticReconcileInput);
    expect(automaticReplay.status).toBe(200);
    expect((await automaticReplay.json()).data.id).toBe(automaticJob.id);
    expect((await store.jobs.get({ tenantId: tenantA, id: automaticJob.id }))?.originAction).toBeUndefined();
    await expect(pool.query<{ count: string }>(
      "select count(*)::text as count from sms_kit.send_job where tenant_id = $1 and message_id = $2 and job_type = 'reconcile'",
      [tenantA, automaticallyScheduledMessage],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(pool.query<{ required_permission: string }>(
      "select required_permission from sms_kit.admin_job_authorization where tenant_id = $1 and job_id = $2",
      [tenantA, automaticJob.id],
    )).resolves.toMatchObject({ rows: [{ required_permission: "receipt.reconcile" }] });
    await expect(operationJobAuthorization({ store }, { tenantId: tenantA, jobId: automaticJob.id }))
      .resolves.toEqual({ requiredPermission: "receipt.reconcile" });
    await expect(operationsRoute({ store }, receiptReconcilerA, "/jobs/:id", undefined, { id: automaticJob.id }, {}))
      .resolves.toMatchObject({ id: automaticJob.id, jobType: "reconcile" });
    expect((await request(receiptReconcilerA, `/jobs/${automaticJob.id}`)).status).toBe(200);
    expect((await request(adminA, `/jobs/${automaticJob.id}`)).status).toBe(200);
    expect((await request(messageReaderA, `/jobs/${automaticJob.id}`)).status).toBe(403);
    expect((await request(adminB, `/jobs/${automaticJob.id}`)).status).toBe(404);

    const smsOriginMessage = await seedMessage({
      tenantId: tenantA,
      idempotencyKey: `operations-sms-origin-reconcile:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "waiting",
      providerBizId: "biz-sms-origin-reconcile",
      attemptCount: 1,
    });
    const smsOriginReconcileJob = await store.jobs.ensureReconcile({
      tenantId: tenantA,
      messageId: smsOriginMessage,
      availableAt: now,
      originAction: "sms.test",
    });
    const smsOriginInput = {
      version: 1,
      idempotencyKey: `reconcile:sms-origin:${smsOriginMessage}`,
      messageId: smsOriginMessage,
    };
    expect((await request(receiptReconcilerA, "/reconcile", "POST", smsOriginInput)).status).toBe(403);
    const crossOriginReconcile = await request(adminA, "/reconcile", "POST", smsOriginInput);
    expect(crossOriginReconcile.status).toBe(200);
    expect((await crossOriginReconcile.json()).data.id).toBe(smsOriginReconcileJob.id);
    // The durable receipt-reconcile replay retains the source-action fence.
    expect((await request(receiptReconcilerA, "/reconcile", "POST", smsOriginInput)).status).toBe(403);
    expect((await request(receiptReconcilerA, `/jobs/${smsOriginReconcileJob.id}`)).status).toBe(403);
    expect((await request(testSenderA, `/jobs/${smsOriginReconcileJob.id}`)).status).toBe(200);

    // Model the narrow race after the preliminary replay lookup: the durable
    // claim below returns an already-completed sms.test-origin operation. The
    // caller must still be checked before that snapshot becomes a JobDto.
    const originalFind = store.adminOperations.find.bind(store.adminOperations);
    let bypassReplayLookup = true;
    store.adminOperations.find = async (input, tx) => {
      if (bypassReplayLookup && input.operation === "receipt.reconcile" && input.idempotencyKey === smsOriginInput.idempotencyKey) {
        bypassReplayLookup = false;
        return undefined;
      }
      return originalFind(input, tx);
    };
    try {
      expect((await request(receiptReconcilerA, "/reconcile", "POST", smsOriginInput)).status).toBe(403);
    } finally {
      store.adminOperations.find = originalFind;
    }

    const receiptHealth = await request(adminA, "/receipt-health");
    expect(receiptHealth.status).toBe(200);
    expect(await receiptHealth.json()).toMatchObject({ data: { systemBudgetRemaining: 499, circuitOpen: true } });
  });

  it("does not deadlock a manual reconciliation against a worker finishing the same PostgreSQL job", async () => {
    const messageId = await seedMessage({
      tenantId: tenantA,
      idempotencyKey: `operations-reconcile-lock-order:${randomUUID()}`,
      acceptanceStatus: "accepted",
      deliveryStatus: "waiting",
      providerBizId: `biz-reconcile-lock-order:${randomUUID()}`,
      attemptCount: 1,
    });
    const job = await store.jobs.ensureReconcile({ tenantId: tenantA, messageId, availableAt: now });
    const leased = (await store.jobs.leaseReconciliation({
      owner: "operations-reconcile-lock-order-worker",
      leaseMs: 60_000,
      limit: 100,
      now,
    })).find((candidate) => candidate.id === job.id);
    expect(leased?.leaseToken).toBeDefined();
    if (leased?.leaseToken === undefined) throw new Error("expected reconciliation lease");

    const workerLockedJob = deferred();
    const adminReachedEnsure = deferred();
    const workerIssuedMessageLock = deferred();
    const originalEnsureReconcile = store.jobs.ensureReconcile;
    store.jobs.ensureReconcile = async (input, tx) => {
      if (tx !== undefined && input.messageId === messageId) {
        adminReachedEnsure.resolve();
        await workerIssuedMessageLock.promise;
      }
      return originalEnsureReconcile.call(store.jobs, input, tx);
    };

    const reconcile = new ReconcileAdminService({
      store,
      authorizer,
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
    });
    const input = {
      expectedVersion: 1,
      idempotencyKey: `reconcile:lock-order:${messageId}`,
      messageId,
    };
    let worker: Promise<void> | undefined;
    let admin: ReturnType<typeof reconcile.enqueue> | undefined;
    let outcomes: readonly PromiseSettledResult<unknown>[] | undefined;
    try {
      worker = store.transaction(async (tx) => {
        await store.jobs.renew({
          tenantId: tenantA,
          id: leased.id,
          leaseToken: leased.leaseToken!,
          leaseMs: 60_000,
          now,
        }, tx);
        workerLockedJob.resolve();
        await adminReachedEnsure.promise;
        const messageUpdate = store.messages.completeQueryDelivery({
          tenantId: tenantA,
          id: messageId,
          status: "delivered",
          occurredAt: now,
        }, tx);
        workerIssuedMessageLock.resolve();
        await messageUpdate;
        await store.jobs.succeed({ tenantId: tenantA, id: leased.id, leaseToken: leased.leaseToken! }, tx);
      });
      await within(workerLockedJob.promise, "worker job lock");
      admin = reconcile.enqueue(receiptReconcilerA, input);
      outcomes = await within(Promise.allSettled([admin, worker]), "reconciliation lock-order race");
    } finally {
      // Release either side if setup failed before the intended lock cycle,
      // then restore the repository before awaiting transaction cleanup.
      adminReachedEnsure.resolve();
      workerIssuedMessageLock.resolve();
      store.jobs.ensureReconcile = originalEnsureReconcile;
      await within(Promise.allSettled([
        ...(admin === undefined ? [] : [admin]),
        ...(worker === undefined ? [] : [worker]),
      ]), "reconciliation race cleanup");
    }

    if (outcomes === undefined) throw new Error("reconciliation lock-order race did not run");

    expect(outcomes.map((outcome) => outcome.status === "fulfilled"
      ? "fulfilled"
      : `${(outcome.reason as SmsKitError).code}:${(outcome.reason as SmsKitError).causeCode ?? "none"}`))
      .toEqual(["fulfilled", "fulfilled"]);
    const scheduled = outcomes[0];
    if (scheduled?.status !== "fulfilled") throw scheduled?.reason;
    expect(scheduled.value).toMatchObject({ kind: "scheduled", job: { id: job.id } });
    await expect(reconcile.enqueue(receiptReconcilerA, input)).resolves.toMatchObject({
      kind: "scheduled",
      job: { id: job.id },
    });
    await expect(store.jobs.get({ tenantId: tenantA, id: job.id })).resolves.toMatchObject({ state: "succeeded" });
  });

  it("validates the host Better Auth snapshot before committing a policy write", async () => {
    const current = await store.policy.get();
    await expect(operationsRoute({ policy }, adminA, "/verification", undefined, {}, {})).resolves.toMatchObject({
      betterAuth: { adapterStatus: "not_configured", loginTemplateKey: null, passwordResetTemplateKey: null },
    });
    await expect(operationsRoute({
      policy,
      betterAuth: {
        get: async () => ({
          adapterStatus: "enabled",
          loginTemplateKey: null,
          passwordResetTemplateKey: null,
        } as never),
      },
    }, adminA, "/verification", {
      version: current.version,
      idempotencyKey: `verification:invalid-host-snapshot:${randomUUID()}`,
      otpLength: current.otpLength,
      otpTtlSeconds: current.otpTtlSeconds,
      otpMaxAttempts: current.otpMaxAttempts,
      proofTtlSeconds: current.proofTtlSeconds,
      phoneMinIntervalSeconds: current.phoneMinIntervalSeconds,
      phoneHourlyLimit: current.phoneHourlyLimit,
      phoneDailyLimit: current.phoneDailyLimit,
      ipWindowSeconds: current.ipWindowSeconds,
      ipWindowLimit: current.ipWindowLimit,
      systemDailyBudget: current.systemDailyBudget,
      circuitOpen: current.circuitOpen,
      ...(current.circuitReason === undefined ? {} : { circuitReason: current.circuitReason }),
    }, {}, {})).rejects.toBeDefined();
    await expect(store.policy.get()).resolves.toMatchObject({ version: current.version });
  });
});
