import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ReceiptService } from "../../../src/application/receipt-service.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantId = "receipt-tenant" as TenantId;
const validToken = Buffer.alloc(32, 7).toString("base64url");

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
    await store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    templateId = (await store.resources.findTemplateByKey({ templateKey: "receipt.delivery" }))!.id;
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "id", accessKeySecretRef: "secret", receiptCallbackTokenRef: "callback", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date(), expectedVersion: config.version });
  }, 120_000);
  afterAll(async () => stop?.());

  const service = () => new ReceiptService({
    store,
    secrets: { resolve: async (reference: string) => reference === "callback" ? validToken : "" },
    clock,
    events: { emit: (event) => { events.push(event); } },
    safetyMarginMs: 50,
  });

  async function acceptedMessage(): Promise<{ id: string; bizId: string }> {
    const id = crypto.randomUUID();
    const created = await store.messages.createWithSendJob({
      id: id as never, tenantId, idempotencyKey: crypto.randomUUID(), templateId: templateId as never,
      templateKeySnapshot: "receipt.delivery", externalTemplateCodeSnapshot: "SMS_RECEIPT", signatureNameSnapshot: "Receipt",
      purpose: "notification", phoneCiphertext: "phone", phoneKeyId: "phone-k1", phoneHash: "hash", phoneLast4: "0000", phoneMasked: "138****0000",
      variableNames: [], metadata: {}, submittedAt: clock.now(),
    });
    const attempt = await store.attempts.createStarted({ tenantId, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: clock.now() });
    const bizId = `biz-${id}`;
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

  it("stops before the injected callback deadline", async () => {
    clock = new Clock();
    const message = await acceptedMessage();
    const deadlineAt = new Date(clock.now().getTime() + 20);
    await expect(service().ingest({ token: validToken, body: batch({ bizId: message.bizId, outId: message.id }), deadlineAt })).rejects.toMatchObject({ code: "STORAGE_FAILURE", retryable: true });
    await expect(pool.query<{ count: string }>("select count(*)::text as count from sms_kit.delivery_receipt where provider_biz_id = $1", [message.bizId])).resolves.toMatchObject({ rows: [{ count: "0" }] });
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
