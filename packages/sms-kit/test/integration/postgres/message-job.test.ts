import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreateMessageInput } from "../../../src/ports/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { asSmsTransaction } from "../../../src/postgres/transaction.js";
import { startPostgres } from "./helpers.js";

const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("PostgreSQL messages, attempts, receipts and jobs", () => {
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;
  let templateId: string;
  let pool: Awaited<ReturnType<typeof startPostgres>>["pool"];

  function messageFixture(overrides: Partial<CreateMessageInput> = {}): CreateMessageInput {
    const id = randomUUID();
    return {
      id: id as CreateMessageInput["id"], tenantId: tenantA, idempotencyKey: `key:${id}`,
      templateId: templateId as CreateMessageInput["templateId"], templateKeySnapshot: "notice.shipped",
      externalTemplateCodeSnapshot: "SMS_1", signatureNameSnapshot: "Production", purpose: "shipping",
      phoneCiphertext: "enc:v1:phone", phoneKeyId: "key-1", phoneHash: "hash", phoneLast4: "1234",
      phoneMasked: "138****1234", variableNames: ["order"], renderParamsCiphertext: "enc:v1:params",
      renderParamsKeyId: "key-1", submittedAt: new Date("2026-09-13T00:00:00.000Z"),
      sendJob: { id: randomUUID(), dedupeKey: `send:${id}`, availableAt: new Date("2026-09-13T00:00:00.000Z"), maxAttempts: 3 },
      ...overrides,
    };
  }

  async function createMessage(input: CreateMessageInput) {
    return store.transaction((tx) => store.messages.createWithSendJob(input, tx));
  }

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    pool = postgres.pool;
    await migrateSmsKit(postgres.pool);
    store = new PgSmsStore(postgres.pool);
    const signatureId = randomUUID();
    templateId = randomUUID();
    await postgres.pool.query(
      `insert into sms_kit.signature (id, external_key, external_name, external_status, external_type, imported_at, last_synced_at, created_at, updated_at)
       values ($1, 'sign:production', 'Production', 'approved', 'text', now(), now(), now(), now())`,
      [signatureId],
    );
    await postgres.pool.query(
      `insert into sms_kit.template (id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, content_snapshot, variable_schema, imported_at, last_synced_at, created_at, updated_at)
       values ($2, $1, 'notice.shipped', 'SMS_1', 'Shipping', 'approved', 'notification', 'shipping', '', '["order"]', now(), now(), now(), now())`,
      [signatureId, templateId],
    );
  }, 120_000);

  afterAll(async () => stop?.());

  it("creates one message and job for concurrent idempotent requests", async () => {
    const input = messageFixture({ idempotencyKey: "order:A-100:shipped" });
    const [first, second] = await Promise.all([createMessage(input), createMessage(input)]);

    expect(first.message.id).toBe(second.message.id);
    expect(first.created || second.created).toBe(true);
    expect((await store.jobs.lease({ tenantId: tenantA, owner: "worker", leaseMs: 60_000, limit: 10, now: new Date("2026-09-13T00:00:01.000Z") })).length).toBe(1);
  });

  it("allows the same idempotency key in different tenants and keeps reads isolated", async () => {
    const key = "order:A-100:shipped:two-tenants";
    const [a, b] = await Promise.all([
      createMessage(messageFixture({ tenantId: tenantA, idempotencyKey: key })),
      createMessage(messageFixture({ tenantId: tenantB, idempotencyKey: key })),
    ]);
    expect(a.message.id).not.toBe(b.message.id);
    expect(await store.messages.get({ tenantId: tenantB, id: a.message.id })).toBeUndefined();
  });

  it("fences stale lease owners and permits one started attempt per message", async () => {
    const created = await createMessage(messageFixture());
    const firstLease = await store.jobs.lease({ tenantId: tenantA, owner: "worker-a", leaseMs: 60_000, limit: 10, now: new Date("2026-09-13T00:00:01.000Z") });
    const job = firstLease.find((candidate) => candidate.messageId === created.message.id);
    expect(job).toBeDefined();
    if (job === undefined) throw new Error("expected the created message job to be leased");
    await store.jobs.reschedule({ tenantId: tenantA, id: job.id, leaseToken: job.leaseToken!, availableAt: new Date("2026-09-13T00:00:02.000Z") });
    const secondLease = await store.jobs.lease({ tenantId: tenantA, owner: "worker-b", leaseMs: 60_000, limit: 10, now: new Date("2026-09-13T00:00:02.000Z") });
    const leasedAgain = secondLease.find((candidate) => candidate.messageId === created.message.id);
    expect(leasedAgain).toBeDefined();
    if (leasedAgain === undefined) throw new Error("expected the rescheduled message job to be leased again");
    expect(leasedAgain.leaseToken).not.toBe(job.leaseToken);
    await expect(store.jobs.succeed({ tenantId: tenantA, id: job.id, leaseToken: job.leaseToken! }))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);

    const first = await store.attempts.createStarted({
      tenantId: tenantA, messageId: created.message.id, dispatchMode: "queued", leaseToken: leasedAgain.leaseToken!,
      dispatchMarkedAt: new Date("2026-09-13T00:00:03.000Z"),
    });
    await expect(store.attempts.createStarted({
      tenantId: tenantA, messageId: created.message.id, dispatchMode: "queued", leaseToken: leasedAgain.leaseToken!,
      dispatchMarkedAt: new Date("2026-09-13T00:00:04.000Z"),
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    expect(first.dispatchToken).toBeTruthy();
  });

  it("never creates a direct attempt for a message outside the trusted tenant", async () => {
    const created = await createMessage(messageFixture());

    await expect(store.attempts.createStarted({
      tenantId: tenantB, messageId: created.message.id, dispatchMode: "direct",
      dispatchMarkedAt: new Date("2026-09-13T00:00:05.000Z"),
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
  });

  it("locks the queued lease through attempt creation so recovery fences a stale dispatcher", async () => {
    const created = await createMessage(messageFixture());
    const jobs = await store.jobs.lease({ tenantId: tenantA, owner: "worker-a", leaseMs: 60_000, limit: 100, now: new Date("2026-09-13T00:00:10.000Z") });
    const job = jobs.find((candidate) => candidate.messageId === created.message.id);
    expect(job).toBeDefined();
    if (job?.leaseToken === undefined) throw new Error("expected a leased job");

    const lockingClient = await pool.connect();
    try {
      await lockingClient.query("begin");
      await lockingClient.query("select id from sms_kit.send_job where id = $1 for update", [job.id]);
      const recovered = store.jobs.reschedule({ tenantId: tenantA, id: job.id, leaseToken: job.leaseToken, availableAt: new Date("2026-09-13T00:00:11.000Z") });
      const started = store.attempts.createStarted({
        tenantId: tenantA, messageId: created.message.id, dispatchMode: "queued", leaseToken: job.leaseToken,
        dispatchMarkedAt: new Date("2026-09-13T00:00:11.000Z"),
      });
      void started.catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await lockingClient.query("commit");
      await recovered;
      await expect(started).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    } finally {
      await lockingClient.query("rollback").catch(() => undefined);
      lockingClient.release();
    }
  });

  it("rejects a send-job dedupe conflict and rolls back its new message", async () => {
    const first = messageFixture({ sendJob: { id: randomUUID(), dedupeKey: "send:conflict", availableAt: new Date("2026-09-13T00:00:00.000Z"), maxAttempts: 3 } });
    await createMessage(first);
    const conflicting = messageFixture({ sendJob: { id: randomUUID(), dedupeKey: "send:conflict", availableAt: new Date("2026-09-13T00:00:00.000Z"), maxAttempts: 3 } });

    await expect(createMessage(conflicting)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<SmsKitError>);
    expect(await store.messages.get({ tenantId: tenantA, id: conflicting.id })).toBeUndefined();
  });

  it("returns the concurrent first reconciliation job without changing its originating permission", async () => {
    const created = await createMessage(messageFixture());
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      await firstClient.query("begin");
      await secondClient.query("begin");
      const firstPid = (await firstClient.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const secondPid = (await secondClient.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const first = await store.jobs.ensureReconcile({
        tenantId: tenantA,
        messageId: created.message.id,
        availableAt: new Date("2026-09-13T00:00:12.000Z"),
        originAction: "sms.test",
      }, asSmsTransaction(firstClient));
      const secondPending = store.jobs.ensureReconcile({
        tenantId: tenantA,
        messageId: created.message.id,
        availableAt: new Date("2026-09-13T00:00:13.000Z"),
        originAction: "receipt.reconcile",
      }, asSmsTransaction(secondClient));
      void secondPending.catch(() => undefined);

      let blockedByFirstCreator = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const blocked = await pool.query<{ blocked: boolean }>(
          "select $2::integer = any(pg_blocking_pids($1::integer)) as blocked",
          [secondPid, firstPid],
        );
        if (blocked.rows[0]?.blocked === true) {
          blockedByFirstCreator = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(blockedByFirstCreator).toBe(true);

      await firstClient.query("commit");
      const second = await secondPending;
      await secondClient.query("commit");

      expect(second).toMatchObject({ id: first.id, originAction: "sms.test" });
      await expect(pool.query<{ count: string; origin_action: string | null }>(
        `select count(*)::text as count, min(origin_action) as origin_action
           from sms_kit.send_job
          where tenant_id = $1 and job_type = 'reconcile' and dedupe_key = $2`,
        [tenantA, `reconcile:${created.message.id}`],
      )).resolves.toMatchObject({ rows: [{ count: "1", origin_action: "sms.test" }] });
    } finally {
      await firstClient.query("rollback").catch(() => undefined);
      await secondClient.query("rollback").catch(() => undefined);
      firstClient.release();
      secondClient.release();
    }
  });

  it("rejects an invalid reconciliation origin even when the deduplicated job already exists", async () => {
    const created = await createMessage(messageFixture());
    await store.jobs.ensureReconcile({
      tenantId: tenantA,
      messageId: created.message.id,
      availableAt: new Date("2026-09-13T00:00:14.000Z"),
    });

    await expect(store.jobs.ensureReconcile({
      tenantId: tenantA,
      messageId: created.message.id,
      availableAt: new Date("2026-09-13T00:00:15.000Z"),
      originAction: "message.read",
    } as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" } satisfies Partial<SmsKitError>);
  });

  it("tenant-constrains receipt association and never discloses an unmatched receipt by dedupe", async () => {
    const created = await createMessage(messageFixture());
    await expect(store.receipts.record({
      tenantId: tenantB, messageId: created.message.id, dedupeKey: "receipt:cross-tenant", providerBizId: "biz-cross",
      deliveryStatus: "delivered", occurredAt: new Date("2026-09-13T00:00:20.000Z"), receivedAt: new Date("2026-09-13T00:00:20.000Z"), source: "callback",
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);

    const firstUnmatched = await store.receipts.record({
      tenantId: tenantA, dedupeKey: "receipt:unmatched", providerBizId: "biz-unmatched",
      deliveryStatus: "failed", occurredAt: new Date("2026-09-13T00:00:21.000Z"), receivedAt: new Date("2026-09-13T00:00:21.000Z"), source: "callback",
    });
    expect(firstUnmatched).toMatchObject({ created: true, receipt: { matchStatus: "unmatched" } });
    const duplicateUnmatched = await store.receipts.record({
      tenantId: tenantB, dedupeKey: "receipt:unmatched", providerBizId: "biz-unmatched",
      deliveryStatus: "failed", occurredAt: new Date("2026-09-13T00:00:21.000Z"), receivedAt: new Date("2026-09-13T00:00:21.000Z"), source: "callback",
    });
    expect(duplicateUnmatched).toMatchObject({ created: false, receipt: { matchStatus: "unmatched" } });
    expect(duplicateUnmatched.receipt).not.toHaveProperty("tenantId");
    expect(duplicateUnmatched.receipt).not.toHaveProperty("messageId");
  });

  it("does not let an own-tenant message claim an unrelated unmatched receipt", async () => {
    const created = await createMessage(messageFixture());
    const attempt = await store.attempts.createStarted({
      tenantId: tenantA, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: new Date("2026-09-13T00:00:22.000Z"),
    });
    await store.messages.completeAcceptance({
      tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "accepted", evidence: "same-dispatch-response",
      providerBizId: "biz-owned", occurredAt: new Date("2026-09-13T00:00:22.000Z"),
    });
    await store.receipts.record({
      tenantId: tenantB, dedupeKey: "receipt:unrelated-unmatched", providerBizId: "biz-unrelated",
      deliveryStatus: "failed", providerMessage: "must remain unclaimed", occurredAt: new Date("2026-09-13T00:00:23.000Z"), receivedAt: new Date("2026-09-13T00:00:23.000Z"), source: "callback",
    });

    await expect(store.receipts.record({
      tenantId: tenantA, messageId: created.message.id, dedupeKey: "receipt:unrelated-unmatched", providerBizId: "biz-unrelated",
      deliveryStatus: "failed", occurredAt: new Date("2026-09-13T00:00:23.000Z"), receivedAt: new Date("2026-09-13T00:00:23.000Z"), source: "callback",
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    await expect(pool.query<{ match_status: string; tenant_id: string | null; message_id: string | null; provider_message: string | null }>("select match_status, tenant_id, message_id, provider_message from sms_kit.delivery_receipt where dedupe_key = 'receipt:unrelated-unmatched'"))
      .resolves.toMatchObject({ rows: [{ match_status: "unmatched", tenant_id: null, message_id: null, provider_message: "must remain unclaimed" }] });
  });

  it("does not reverse a terminal receipt when the accepted response arrives later", async () => {
    const created = await createMessage(messageFixture());
    const attempt = await store.attempts.createStarted({
      tenantId: tenantA, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: new Date("2026-09-13T00:01:00.000Z"),
    });
    await store.messages.completeDelivery({
      tenantId: tenantA, id: created.message.id, status: "delivered", occurredAt: new Date("2026-09-13T00:01:01.000Z"),
    });

    const completed = await store.messages.completeAcceptance({
      tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "accepted", evidence: "same-dispatch-response",
      occurredAt: new Date("2026-09-13T00:01:02.000Z"),
    });

    expect(completed).toMatchObject({ acceptanceStatus: "accepted", deliveryStatus: "delivered" });
    expect(completed.acceptedAt).toEqual(new Date("2026-09-13T00:01:02.000Z"));
  });

  it("preserves unknown-final delivery and only records accepted_at for acceptance", async () => {
    const created = await createMessage(messageFixture());
    const attempt = await store.attempts.createStarted({
      tenantId: tenantA, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: new Date("2026-09-13T00:02:00.000Z"),
    });
    const unknown = await store.messages.completeAcceptance({
      tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "unknown", evidence: "same-dispatch-response",
      occurredAt: new Date("2026-09-13T00:02:01.000Z"),
    });
    expect(unknown.acceptedAt).toBeUndefined();
    await store.messages.completeDelivery({
      tenantId: tenantA, id: created.message.id, status: "unknown_final", occurredAt: new Date("2026-09-13T00:02:02.000Z"),
    });
    const accepted = await store.messages.completeAcceptance({
      tenantId: tenantA, dispatchToken: attempt.dispatchToken, status: "accepted", evidence: "positive-provider-evidence",
      occurredAt: new Date("2026-09-13T00:02:03.000Z"),
    });
    expect(accepted).toMatchObject({ acceptanceStatus: "accepted", deliveryStatus: "unknown_final" });
    expect(accepted.acceptedAt).toEqual(new Date("2026-09-13T00:02:03.000Z"));

    const rejectedMessage = await createMessage(messageFixture());
    const rejectedAttempt = await store.attempts.createStarted({
      tenantId: tenantA, messageId: rejectedMessage.message.id, dispatchMode: "direct", dispatchMarkedAt: new Date("2026-09-13T00:03:00.000Z"),
    });
    const rejected = await store.messages.completeAcceptance({
      tenantId: tenantA, dispatchToken: rejectedAttempt.dispatchToken, status: "rejected", evidence: "same-dispatch-response",
      occurredAt: new Date("2026-09-13T00:03:01.000Z"),
    });
    expect(rejected.acceptedAt).toBeUndefined();
  });

  it("projects message metadata and unmatched receipt payloads before JSON persistence", async () => {
    const created = await createMessage(messageFixture({ metadata: {
      redactedFields: ["phone", "not-allowed"],
      counts: [{ name: "message", value: 1 }, { name: "receipt", value: Number.POSITIVE_INFINITY }],
      phone: "+8613800138000",
      nested: { secret: "must-not-persist" },
    } as never }));
    const storedMessage = await pool.query<{ metadata: unknown }>("select metadata from sms_kit.send_message where id = $1", [created.message.id]);
    expect(storedMessage.rows[0]?.metadata).toEqual({ redactedFields: ["phone"], counts: [{ name: "message", value: 1 }] });

    await store.receipts.record({
      tenantId: tenantA, dedupeKey: `receipt:payload:${randomUUID()}`, providerBizId: "biz-payload", deliveryStatus: "failed",
      occurredAt: new Date("2026-09-13T00:04:00.000Z"), receivedAt: new Date("2026-09-13T00:04:00.000Z"), source: "callback",
      redactedPayload: { redactedFields: ["otp", "unknown"], reportCount: 3, nested: { phone: "+8613800138000" } } as never,
    });
    const storedReceipt = await pool.query<{ redacted_payload: unknown }>("select redacted_payload from sms_kit.delivery_receipt where provider_biz_id = 'biz-payload'");
    expect(storedReceipt.rows[0]?.redacted_payload).toEqual({ redactedFields: ["otp"], reportCount: 3 });
  });

  it("rolls back after an abort while completed work is paused before the commit boundary", async () => {
    const controller = new AbortController();
    const eventId = randomUUID();
    const workCompleted = deferred<void>();
    const releaseWork = deferred<void>();
    const transaction = store.transaction(async (tx) => {
      await store.audits.append({
        id: eventId,
        tenantId: tenantA,
        actorId: "receipt-deadline",
        action: "receipt.abort-test",
        targetType: "delivery_receipt",
        result: "failed",
        occurredAt: new Date("2026-09-13T00:05:00.000Z"),
      }, tx);
      workCompleted.resolve(undefined);
      await releaseWork.promise;
    }, { signal: controller.signal });
    void transaction.catch(() => undefined);

    await workCompleted.promise;
    controller.abort(new Error("deadline"));
    releaseWork.resolve(undefined);

    await expect(transaction).rejects.toMatchObject({ code: "STORAGE_FAILURE", retryable: true });
    await expect(pool.query<{ count: string }>(
      "select count(*)::text as count from sms_kit.audit_event where id = $1",
      [eventId],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});
