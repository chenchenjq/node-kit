import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

import { ReceiptService } from "../../../src/application/receipt-service.js";
import { createAliyunReceiptHandler } from "../../../src/next/receipt-handler.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { SmsStore } from "../../../src/ports/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantId = "receipt-tenant" as TenantId;
const validToken = Buffer.alloc(32, 7).toString("base64url");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function queryText(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "object" && value !== null && "text" in value && typeof value.text === "string") {
    return value.text.trim().toLowerCase();
  }
  return "";
}

class Clock {
  constructor(private value = new Date("2026-09-14T00:00:00.000Z")) {}
  now(): Date { return new Date(this.value); }
  set(value: Date): void { this.value = new Date(value); }
}

describe("ReceiptService", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;
  let clock: Clock;
  let templateId: string;
  const events: unknown[] = [];

  beforeAll(async () => {
    const postgres = await startPostgres(); pool = postgres.pool; stop = postgres.stop;
    await migrateSmsKit(pool); store = new PgSmsStore(pool);
    const signature = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "receipt-sign", changeType: "new", checksum: "receipt-signature", resourceType: "signature", snapshot: { kind: "signature", externalName: "Receipt", externalStatus: "approved", externalType: "text" } });
    const template = createResourceSyncCandidate({ id: crypto.randomUUID(), externalKey: "receipt-template", changeType: "new", checksum: "receipt-template", resourceType: "template", signatureExternalKey: "receipt-sign", templateKey: "receipt.delivery", purpose: "notification", snapshot: { kind: "template", externalCode: "SMS_RECEIPT", externalName: "Receipt", externalStatus: "approved", templateType: "notification", variableNames: [] } });
    const preview = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await store.resources.commitSync({ syncId: preview.id, candidates: [{ id: signature.id, checksum: signature.checksum }] });
    const importedSignature = (await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0];
    if (importedSignature === undefined) throw new Error("receipt signature fixture is missing");
    await store.transaction((tx) => store.resources.importTemplate({
      candidateId: template.id,
      checksum: template.checksum,
      templateKey: "receipt.delivery",
      purpose: "notification",
      signatureExternalKey: signature.externalKey,
      expectedSignatureVersion: importedSignature.version,
      now: new Date("2026-09-14T00:00:00.000Z"),
    }, tx));
    templateId = (await store.resources.findTemplateByKey({ templateKey: "receipt.delivery" }))!.id;
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "id", accessKeySecretRef: "secret", receiptCallbackTokenRef: "callback", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date(), expectedVersion: config.version });
  }, 120_000);
  afterAll(async () => stop?.());

  const service = (
    eventSink: { emit(event: unknown): void | Promise<void> } = { emit: (event) => { events.push(event); } },
    currentStore: SmsStore = store,
  ) => new ReceiptService({
    store: currentStore,
    secrets: { resolve: async (reference: string) => reference === "callback" ? validToken : "" },
    clock,
    events: eventSink as never,
    safetyMarginMs: 50,
  });

  async function acceptedMessage(id = crypto.randomUUID(), bizId = `biz-${id}`): Promise<{ id: string; bizId: string }> {
    const created = await store.messages.createWithSendJob({
      id: id as never, tenantId, idempotencyKey: crypto.randomUUID(), templateId: templateId as never,
      templateKeySnapshot: "receipt.delivery", externalTemplateCodeSnapshot: "SMS_RECEIPT", signatureNameSnapshot: "Receipt",
      purpose: "notification", phoneCiphertext: "phone", phoneKeyId: "phone-k1", phoneHash: "hash", phoneLast4: "0000", phoneMasked: "138****0000",
      variableNames: [], metadata: {}, submittedAt: clock.now(),
    });
    const attempt = await store.attempts.createStarted({ tenantId, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: clock.now() });
    await store.messages.completeAcceptance({ tenantId, dispatchToken: attempt.dispatchToken, status: "accepted", evidence: "same-dispatch-response", providerBizId: bizId, occurredAt: clock.now() });
    return { id, bizId };
  }

  function batch(input: Readonly<{ bizId: string; outId: string; success?: boolean; code?: string }>): string {
    return JSON.stringify([{
      phone_number: "13800138000", biz_id: input.bizId, send_time: "2026-09-14 08:00:00", report_time: "2026-09-14 08:00:05",
      success: input.success ?? true, err_code: input.code ?? "DELIVERED", err_msg: "provider detail", sms_size: "1", out_id: input.outId,
    }]);
  }

  it("rejects a wrong callback token before parsing the body", async () => {
    clock = new Clock();
    await expect(service().ingest({ token: "wrong", body: "not JSON", deadlineAt: new Date(clock.now().getTime() + 1_000) })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("counts concurrent duplicate receipts once and advances the delivery state once", async () => {
    clock = new Clock();
    const message = await acceptedMessage();
    await Promise.all([
      service().ingest({ token: validToken, body: batch({ bizId: message.bizId, outId: message.id }), deadlineAt: new Date(clock.now().getTime() + 1_000) }),
      service().ingest({ token: validToken, body: batch({ bizId: message.bizId, outId: message.id }), deadlineAt: new Date(clock.now().getTime() + 1_000) }),
    ]);
    await expect(pool.query<{ count: string }>("select count(*)::text as count from sms_kit.delivery_receipt where provider_biz_id = $1", [message.bizId])).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(store.messages.get({ tenantId, id: message.id as never })).resolves.toMatchObject({ deliveryStatus: "delivered" });
  });

  it("acknowledges a valid unmatched receipt idempotently", async () => {
    clock = new Clock();
    const body = batch({ bizId: "unmatched-biz", outId: "unmatched-out" });
    const first = await service().ingest({ token: validToken, body, deadlineAt: new Date(clock.now().getTime() + 1_000) });
    const second = await service().ingest({ token: validToken, body, deadlineAt: new Date(clock.now().getTime() + 1_000) });
    expect(first.acknowledgement).toEqual({ code: 0, msg: "成功" });
    expect(second.acknowledgement).toEqual({ code: 0, msg: "成功" });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from sms_kit.delivery_receipt where match_status = 'unmatched' and provider_biz_id = 'unmatched-biz'")).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("promotes an unmatched receipt after its message is durably accepted without trusting callback tenancy", async () => {
    clock = new Clock();
    const id = crypto.randomUUID();
    const bizId = `biz-${id}`;
    const body = batch({ bizId, outId: id });
    await service().ingest({ token: validToken, body, deadlineAt: new Date(clock.now().getTime() + 1_000) });
    await acceptedMessage(id, bizId);

    await expect(service().ingest({ token: validToken, body, deadlineAt: new Date(clock.now().getTime() + 1_000) })).resolves.toMatchObject({ acknowledgement: { code: 0 } });
    await expect(pool.query<{ count: string; match_status: string; tenant_id: string; message_id: string }>("select count(*) over()::text as count, match_status, tenant_id, message_id from sms_kit.delivery_receipt where provider_biz_id = $1", [bizId])).resolves.toMatchObject({ rows: [{ count: "1", match_status: "matched", tenant_id: tenantId, message_id: id }] });
    await expect(store.messages.get({ tenantId, id: id as never })).resolves.toMatchObject({ deliveryStatus: "delivered" });
  });

  it("does not persist provider err_msg content", async () => {
    clock = new Clock();
    const message = await acceptedMessage();
    const body = batch({ bizId: message.bizId, outId: message.id, success: false, code: "FAILED" }).replace("provider detail", "private provider detail");
    await service().ingest({ token: validToken, body, deadlineAt: new Date(clock.now().getTime() + 1_000) });

    await expect(pool.query<{ provider_message: string | null; redacted_payload: unknown }>("select provider_message, redacted_payload from sms_kit.delivery_receipt where provider_biz_id = $1", [message.bizId])).resolves.toMatchObject({ rows: [{ provider_message: null, redacted_payload: { redactedFields: ["phone"], reportCount: 1 } }] });
  });

  it("acknowledges durable receipts when the optional event sink throws", async () => {
    clock = new Clock();
    const body = batch({ bizId: `unmatched-${crypto.randomUUID()}`, outId: "unmatched-out" });
    await expect(service({ emit: () => { throw new Error("observer unavailable"); } }).ingest({ token: validToken, body, deadlineAt: new Date(clock.now().getTime() + 1_000) })).resolves.toEqual({ acknowledgement: { code: 0, msg: "成功" } });
  });

  it("does not wait for an optional event sink that never resolves", async () => {
    clock = new Clock();
    const body = batch({ bizId: `unmatched-${crypto.randomUUID()}`, outId: "unmatched-out" });
    const result = await Promise.race([
      service({ emit: async () => new Promise<void>(() => undefined) }).ingest({ token: validToken, body, deadlineAt: new Date(clock.now().getTime() + 1_000) }),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    expect(result).toEqual({ acknowledgement: { code: 0, msg: "成功" } });
  });

  it("stops before the injected callback deadline", async () => {
    clock = new Clock();
    const message = await acceptedMessage();
    const deadlineAt = new Date(clock.now().getTime() + 20);
    await expect(service().ingest({ token: validToken, body: batch({ bizId: message.bizId, outId: message.id }), deadlineAt })).rejects.toMatchObject({ code: "STORAGE_FAILURE", retryable: true });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from sms_kit.delivery_receipt where provider_biz_id = $1", [message.bizId])).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("cooperatively aborts inside receipt processing before a late callback can be persisted", async () => {
    clock = new Clock();
    const message = await acceptedMessage();
    const controller = new AbortController();
    const messages = new Proxy(store.messages, {
      get(target, property) {
        if (property === "lockByReceiptReference") {
          return async (...args: Parameters<typeof target.lockByReceiptReference>) => {
            const result = await target.lockByReceiptReference(...args);
            controller.abort(new Error("callback deadline reached"));
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const abortingStore = {
      ...store,
      transaction: store.transaction.bind(store),
      messages,
    } as SmsStore;

    await expect(service(undefined, abortingStore).ingest({
      token: validToken,
      body: batch({ bizId: message.bizId, outId: message.id }),
      deadlineAt: new Date(clock.now().getTime() + 1_000),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "STORAGE_FAILURE", retryable: true });
    await expect(pool.query<{ count: string }>(
      "select count(*)::text as count from sms_kit.delivery_receipt where provider_biz_id = $1",
      [message.bizId],
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(store.messages.get({ tenantId, id: message.id as never })).resolves.toMatchObject({ deliveryStatus: "waiting" });
  });

  it("returns 503 during a dispatched COMMIT and absorbs the idempotent late completion", async () => {
    clock = new Clock();
    const message = await acceptedMessage();
    const commitApplied = deferred<void>();
    const releaseCommitResponse = deferred<void>();
    let rollbackWhileCommitPending = false;
    let releaseWhileCommitPending = false;
    let commitResponsePending = false;
    const delayedPool = new Proxy(pool, {
      get(target, property) {
        if (property !== "connect") {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === "release") {
                return (...args: unknown[]) => {
                  if (commitResponsePending) releaseWhileCommitPending = true;
                  return Reflect.apply(clientTarget.release, clientTarget, args);
                };
              }
              if (clientProperty !== "query") {
                const value = Reflect.get(clientTarget, clientProperty, clientTarget) as unknown;
                return typeof value === "function" ? value.bind(clientTarget) : value;
              }
              return async (...args: unknown[]) => {
                const sql = queryText(args[0]);
                if (sql === "rollback" && commitResponsePending) rollbackWhileCommitPending = true;
                const result = await query(...args);
                if (sql === "commit") {
                  // PostgreSQL has durably committed here; only withhold the
                  // JavaScript-visible query result to model a slow response.
                  commitResponsePending = true;
                  commitApplied.resolve(undefined);
                  await releaseCommitResponse.promise;
                  commitResponsePending = false;
                }
                return result;
              };
            },
          }) as PoolClient;
        };
      },
    }) as Pool;
    const delayedStore = new PgSmsStore(delayedPool);
    const receiptService = service(undefined, delayedStore);
    let lateIngest: Promise<unknown> | undefined;
    const callback = createAliyunReceiptHandler({
      clock,
      verifyToken: (value) => value === validToken,
      receiptService: {
        ingest(input) {
          lateIngest = receiptService.ingest(input);
          return lateIngest;
        },
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      const callbackResponse = callback(new Request(`https://sms.example.test/api/sms/receipt/${validToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: batch({ bizId: message.bizId, outId: message.id }),
      }));
      await commitApplied.promise;

      await vi.advanceTimersByTimeAsync(651);
      const response = await callbackResponse;

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "callback temporarily unavailable", retryable: true });
      await expect(pool.query<{ count: string }>(
        "select count(*)::text as count from sms_kit.delivery_receipt where provider_biz_id = $1",
        [message.bizId],
      )).resolves.toMatchObject({ rows: [{ count: "1" }] });

      const completion = lateIngest;
      if (completion === undefined) throw new Error("receipt ingest did not reach the commit boundary");
      releaseCommitResponse.resolve(undefined);
      await expect(completion).rejects.toMatchObject({ code: "STORAGE_FAILURE", retryable: true });
      expect(rollbackWhileCommitPending).toBe(false);
      expect(releaseWhileCommitPending).toBe(false);

      const retry = createAliyunReceiptHandler({
        clock,
        verifyToken: (value) => value === validToken,
        receiptService: service(),
      });
      const replay = await retry(new Request(`https://sms.example.test/api/sms/receipt/${validToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: batch({ bizId: message.bizId, outId: message.id }),
      }));

      expect(replay.status).toBe(200);
      await expect(pool.query<{ count: string }>(
        "select count(*)::text as count from sms_kit.delivery_receipt where provider_biz_id = $1",
        [message.bizId],
      )).resolves.toMatchObject({ rows: [{ count: "1" }] });
      await expect(store.messages.get({ tenantId, id: message.id as never }))
        .resolves.toMatchObject({ deliveryStatus: "delivered" });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).toEqual([]);
    } finally {
      releaseCommitResponse.resolve(undefined);
      await lateIngest?.catch(() => undefined);
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it("records a terminal conflict without regressing a delivered message", async () => {
    clock = new Clock();
    const message = await acceptedMessage();
    await service().ingest({ token: validToken, body: batch({ bizId: message.bizId, outId: message.id }), deadlineAt: new Date(clock.now().getTime() + 1_000) });
    await service().ingest({ token: validToken, body: batch({ bizId: message.bizId, outId: message.id, success: false, code: "FAILED" }), deadlineAt: new Date(clock.now().getTime() + 1_000) });
    await expect(store.messages.get({ tenantId, id: message.id as never })).resolves.toMatchObject({ deliveryStatus: "delivered" });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from sms_kit.delivery_receipt where provider_biz_id = $1", [message.bizId])).resolves.toMatchObject({ rows: [{ count: "2" }] });
    expect(events).toContainEqual(expect.objectContaining({ name: "sms.receipt.terminal_conflict" }));
  });
});
