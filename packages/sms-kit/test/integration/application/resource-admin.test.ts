import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ResourceAdminService } from "../../../src/application/resource-admin-service.js";
import { SendService } from "../../../src/application/send-service.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { normalizeMainlandPhone } from "../../../src/core/phone.js";
import type { MessageId, TenantId } from "../../../src/core/types.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { createResourceSyncCandidate, type SmsStore } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const systemTenant = "__system__" as TenantId;
const actorA = { id: "resource-admin-a", tenantId: "tenant-resource-a" as TenantId } as AuthorizationActor;
const actorB = { id: "resource-admin-b", tenantId: "tenant-resource-b" as TenantId } as AuthorizationActor;
const now = new Date("2026-09-14T00:00:00.000Z");

describe("ResourceAdminService with PostgreSQL", () => {
  let pool: Pool;
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;
  let service: ResourceAdminService<AuthorizationActor>;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    service = new ResourceAdminService({
      store,
      authorizer: { assert: () => undefined },
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
      events: { emit: () => undefined },
    });
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`truncate table
      sms_kit.admin_operation, sms_kit.audit_event, sms_kit.send_job, sms_kit.send_attempt,
      sms_kit.delivery_receipt, sms_kit.send_message, sms_kit.resource_sync_candidate,
      sms_kit.resource_sync, sms_kit.template, sms_kit.signature cascade`);
    const signature = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:sign:admin", changeType: "new", checksum: "seed-signature",
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: "Admin signature", externalStatus: "approved", externalType: "通用类型",
      },
    });
    const template = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:template:SMS_ADMIN", changeType: "new", checksum: "seed-template",
      resourceType: "template", signatureExternalKey: signature.externalKey,
      templateKey: "notice.admin", purpose: "notification",
      snapshot: {
        kind: "template", externalCode: "SMS_ADMIN", externalName: "Admin template",
        externalStatus: "approved", templateType: "notification", variableNames: ["code"],
      },
    });
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template],
    });
    await store.resources.commitSync({
      syncId: preview.id,
      candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })),
      now,
    });
  });

  afterAll(async () => stop?.());

  it("lists global resources and applies one tenant-fenced signature update", async () => {
    const signature = (await service.listSignatures(actorA, { page: 1, pageSize: 10 })).items[0]!;
    expect((await service.listTemplates(actorB, { page: 1, pageSize: 10 })).total).toBe(1);

    const input = { id: signature.id, version: signature.version, idempotencyKey: "signature:disable", enabled: false };
    const first = await service.updateSignature(actorA, input);
    const replay = await service.updateSignature(actorA, input);

    expect(first).toMatchObject({ enabled: false, version: signature.version + 1 });
    expect(replay).toEqual(first);
    await expect(service.updateSignature(actorA, { ...input, enabled: true })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    } satisfies Partial<SmsKitError>);
    await expect(service.updateSignature(actorB, input)).rejects.toMatchObject({
      code: "CONCURRENT_MODIFICATION",
    } satisfies Partial<SmsKitError>);
    await expect(store.audits.list({ tenantId: systemTenant, page: 1, pageSize: 10 })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ action: "signature.update", targetId: signature.id })],
    });
  });

  it("imports an uncommitted checksummed candidate from a running preview and replays its original snapshot", async () => {
    const signature = (await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]!;
    const candidate = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:template:SMS_IMPORTED", changeType: "new", checksum: "import-checksum",
      resourceType: "template", signatureExternalKey: signature.externalKey,
      templateKey: "notice.imported", purpose: "notification",
      snapshot: {
        kind: "template", externalCode: "SMS_IMPORTED", externalName: "Imported template",
        externalStatus: "approved", templateType: "notification", variableNames: ["orderNo"],
      },
    });
    if (candidate.resourceType !== "template") throw new Error("template candidate was not created");
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: actorA.id, expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [candidate],
    });
    const input = {
      version: signature.version, idempotencyKey: "template:import", candidateId: candidate.id,
      checksum: candidate.checksum, templateKey: candidate.templateKey, purpose: candidate.purpose,
      signatureExternalKey: candidate.signatureExternalKey,
    };

    const imported = await service.importTemplate(actorA, input);
    await service.updateTemplate(actorA, {
      id: imported.id, version: imported.version, idempotencyKey: "template:purpose", purpose: "shipping",
    });
    const replay = await service.importTemplate(actorA, input);

    expect(imported).toMatchObject({ templateKey: "notice.imported", purpose: "notification", version: 1 });
    expect(replay).toEqual(imported);
    await expect(service.importTemplate(actorA, { ...input, purpose: "different" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    } satisfies Partial<SmsKitError>);
    await expect(pool.query("select committed_at is not null as committed from sms_kit.resource_sync_candidate where id = $1", [candidate.id]))
      .resolves.toMatchObject({ rows: [{ committed: true }] });
    await expect(pool.query<{ status: string; committed: string }>(
      "select status, summary ->> 'committedCount' as committed from sms_kit.resource_sync where id = $1",
      [preview.id],
    )).resolves.toMatchObject({ rows: [{ status: "succeeded", committed: "1" }] });
  });

  it("rejects a later batch commit that reselects an independently imported template", async () => {
    const signature = (await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]!;
    const signatureCandidate = createResourceSyncCandidate({
      id: randomUUID(), externalKey: signature.externalKey, changeType: "unchanged", checksum: "remaining-signature",
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: signature.externalName, externalStatus: signature.externalStatus,
        externalType: signature.externalType,
      },
    });
    const templateCandidate = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:template:SMS_IMPORTED_ONCE", changeType: "new", checksum: "imported-once",
      resourceType: "template", signatureExternalKey: signature.externalKey,
      templateKey: "notice.imported-once", purpose: "notification",
      snapshot: {
        kind: "template", externalCode: "SMS_IMPORTED_ONCE", externalName: "Imported once",
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    if (templateCandidate.resourceType !== "template") throw new Error("template candidate was not created");
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: actorA.id, expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [signatureCandidate, templateCandidate],
    });

    const imported = await service.importTemplate(actorA, {
      version: signature.version, idempotencyKey: "template:import-once", candidateId: templateCandidate.id,
      checksum: templateCandidate.checksum, templateKey: templateCandidate.templateKey,
      purpose: templateCandidate.purpose, signatureExternalKey: templateCandidate.signatureExternalKey,
    });
    await expect(pool.query("select status from sms_kit.resource_sync where id = $1", [preview.id]))
      .resolves.toMatchObject({ rows: [{ status: "running" }] });

    await expect(store.resources.commitSync({
      syncId: preview.id,
      candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })),
      now,
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    await expect(store.resources.findTemplateByKey({ templateKey: templateCandidate.templateKey }))
      .resolves.toMatchObject({ id: imported.id, version: imported.version });
  });

  it.each(["failed", "succeeded"] as const)("rejects a candidate whose parent preview is terminal: %s", async (status) => {
    const signature = (await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]!;
    const candidate = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:template:SMS_FAILED_PARENT", changeType: "new", checksum: "failed-parent-checksum",
      resourceType: "template", signatureExternalKey: signature.externalKey,
      templateKey: "notice.failed-parent", purpose: "notification",
      snapshot: {
        kind: "template", externalCode: "SMS_FAILED_PARENT", externalName: "Failed parent",
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    if (candidate.resourceType !== "template") throw new Error("template candidate was not created");
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: actorA.id, expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [candidate],
    });
    await pool.query("update sms_kit.resource_sync set status = $2, finished_at = now() where id = $1", [preview.id, status]);

    await expect(service.importTemplate(actorA, {
      version: signature.version,
      idempotencyKey: "template:failed-parent",
      candidateId: candidate.id,
      checksum: candidate.checksum,
      templateKey: candidate.templateKey,
      purpose: candidate.purpose,
      signatureExternalKey: candidate.signatureExternalKey,
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    await expect(store.resources.findTemplateByKey({ templateKey: candidate.templateKey })).resolves.toBeUndefined();
  });

  it("rejects a stable-key rename after any tenant has sent the template", async () => {
    const template = await store.resources.findTemplateByKey({ templateKey: "notice.admin" });
    if (template === undefined) throw new Error("seed template missing");
    await store.messages.createWithSendJob({
      id: randomUUID() as MessageId, tenantId: actorB.tenantId, idempotencyKey: "used-template",
      templateId: template.id, templateKeySnapshot: template.templateKey,
      externalTemplateCodeSnapshot: template.externalCode, signatureNameSnapshot: "Admin signature",
      purpose: template.purpose, phoneCiphertext: "ciphertext", phoneKeyId: "key-1", phoneHash: "hash",
      phoneLast4: "0000", phoneMasked: "***0000", variableNames: ["code"], submittedAt: now,
    });

    await expect(service.updateTemplate(actorA, {
      id: template.id, version: template.version, idempotencyKey: "template:rename-used", templateKey: "notice.renamed",
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    await expect(store.resources.findTemplateByKey({ templateKey: "notice.admin" })).resolves.toMatchObject({ version: template.version });
  });

  it("holds the template lock through message creation so a racing rename observes the send", async () => {
    let enteredCreate!: () => void;
    let releaseCreate!: () => void;
    const createEntered = new Promise<void>((resolve) => { enteredCreate = resolve; });
    const createReleased = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const messages = {
      createWithSendJob: async (input: Parameters<PgSmsStore["messages"]["createWithSendJob"]>[0], tx?: Parameters<PgSmsStore["messages"]["createWithSendJob"]>[1]) => {
        enteredCreate();
        await createReleased;
        return store.messages.createWithSendJob(input, tx);
      },
    };
    const sendStore = new Proxy(store, {
      get(target, property) {
        if (property === "messages") return messages;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as SmsStore;
    const send = new SendService({
      store: sendStore,
      provider: {} as never,
      phoneProtector: {
        protect: async () => ({ ciphertext: "phone", keyId: "key-1", lookupHash: "hash", last4: "0000", masked: "***0000" }),
        unprotect: async () => normalizeMainlandPhone("13800138000"),
      },
      payloadProtector: {
        seal: async () => ({ ciphertext: "params", keyId: "key-1" }),
        open: async () => ({ code: "123456" }),
      },
      clock: { now: () => now },
      ids: { next: () => randomUUID(), messageId: () => randomUUID() as MessageId },
      events: { emit: () => undefined },
      providerTimeoutMs: 1_000,
    });
    const template = await store.resources.findTemplateByKey({ templateKey: "notice.admin" });
    if (template === undefined) throw new Error("seed template missing");
    const sending = send.enqueueNotification({
      tenantId: actorB.tenantId, templateKey: template.templateKey, phone: "13800138000",
      variables: { code: "123456" }, purpose: template.purpose, idempotencyKey: "send-race",
    });
    await createEntered;
    let renameSettled = false;
    const rename = service.updateTemplate(actorA, {
      id: template.id, version: template.version, idempotencyKey: "template:rename-race", templateKey: "notice.raced",
    }).finally(() => { renameSettled = true; });
    let waitedOnLock = false;
    for (let attempt = 0; attempt < 100 && !renameSettled; attempt += 1) {
      const waiting = await pool.query<{ waiting: boolean }>(`select exists (
        select 1 from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
           and query ilike '%sms_kit.template%for update%'
      ) as waiting`);
      if (waiting.rows[0]?.waiting) { waitedOnLock = true; break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    releaseCreate();

    await expect(sending).resolves.toMatchObject({ templateKeySnapshot: "notice.admin" });
    expect(waitedOnLock).toBe(true);
    await expect(rename).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
  });
});
