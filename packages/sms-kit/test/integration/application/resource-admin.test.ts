import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import { ResourceAdminService } from "../../../src/application/resource-admin-service.js";
import { SendService } from "../../../src/application/send-service.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { normalizeMainlandPhone } from "../../../src/core/phone.js";
import type { MessageId, TenantId } from "../../../src/core/types.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import {
  createResourceSyncCandidate,
  hasTemplateResourceSelection,
  type SmsStore,
  type SmsTransaction,
} from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { asSmsTransaction, type PgSmsTransaction } from "../../../src/postgres/transaction.js";
import { startPostgres } from "../postgres/helpers.js";

const systemTenant = "__system__" as TenantId;
const actorA = { id: "resource-admin-a", tenantId: "tenant-resource-a" as TenantId } as AuthorizationActor;
const actorB = { id: "resource-admin-b", tenantId: "tenant-resource-b" as TenantId } as AuthorizationActor;
const now = new Date("2026-09-14T00:00:00.000Z");

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

type QueryBarrier = Readonly<{
  matches(sql: string): boolean;
  entered: Deferred<void>;
  release: Deferred<void>;
}>;

function sqlText(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim().toLowerCase();
  if (typeof value === "object" && value !== null && "text" in value && typeof value.text === "string") {
    return value.text.replace(/\s+/g, " ").trim().toLowerCase();
  }
  return "";
}

function instrumentTransactions(
  store: PgSmsStore,
  tag: string,
  barrier?: QueryBarrier,
): Readonly<{ store: SmsStore; pid: Promise<number>; pgCodes: string[] }> {
  const pid = deferred<number>();
  const pgCodes: string[] = [];
  const instrumented = new Proxy(store, {
    get(target, property) {
      if (property !== "transaction") return Reflect.get(target, property, target);
      return async <T>(work: (tx: SmsTransaction) => Promise<T>): Promise<T> => target.transaction(async (tx) => {
        const client = (tx as PgSmsTransaction).client;
        const backend = await client.query<{ pid: number }>("select pg_backend_pid()::integer as pid");
        pid.resolve(backend.rows[0]!.pid);
        await client.query("select set_config('application_name', $1, true)", [tag]);
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        const hookedClient = new Proxy(client, {
          get(clientTarget, clientProperty) {
            if (clientProperty !== "query") {
              const value = Reflect.get(clientTarget, clientProperty, clientTarget) as unknown;
              return typeof value === "function" ? value.bind(clientTarget) : value;
            }
            return async (...args: unknown[]): Promise<unknown> => {
              try {
                const result = await query(...args);
                if (barrier?.matches(sqlText(args[0]))) {
                  barrier.entered.resolve(undefined);
                  await barrier.release.promise;
                }
                return result;
              } catch (error) {
                if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
                  pgCodes.push(error.code);
                }
                throw error;
              }
            };
          },
        }) as PoolClient;
        return work(asSmsTransaction(hookedClient));
      });
    },
  });
  return { store: instrumented as unknown as SmsStore, pid: pid.promise, pgCodes };
}

async function waitUntilBlockedBy(pool: Pool, blockedPid: number, blockingPid: number, description: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      "select $2::integer = any(pg_blocking_pids($1::integer)) as blocked",
      [blockedPid, blockingPid],
    );
    if (rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

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
    if (!hasTemplateResourceSelection(template)) throw new Error("seed template selection is missing");
    await store.resources.commitSync({
      syncId: preview.id,
      candidates: [{ id: signature.id, checksum: signature.checksum }],
      now,
    });
    await store.transaction((tx) => store.resources.importTemplate({
      candidateId: template.id,
      checksum: template.checksum,
      templateKey: template.templateKey,
      purpose: template.purpose,
      signatureExternalKey: template.signatureExternalKey,
      expectedSignatureVersion: 1,
      now,
    }, tx));
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
    if (!hasTemplateResourceSelection(candidate)) throw new Error("selected template candidate was not created");
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

  it("never lets a mapped new template cross the resource.sync permission boundary", async () => {
    const signature = (await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]!;
    const candidate = createResourceSyncCandidate({
      id: randomUUID(), externalKey: "aliyun:template:SMS_EXPLICIT_ONLY", changeType: "new", checksum: "explicit-only-checksum",
      resourceType: "template", signatureExternalKey: signature.externalKey,
      templateKey: "notice.explicit-only", purpose: "notification",
      snapshot: {
        kind: "template", externalCode: "SMS_EXPLICIT_ONLY", externalName: "Explicit only",
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    if (!hasTemplateResourceSelection(candidate)) throw new Error("selected template candidate was not created");
    const preview = await store.resources.createSyncPreview({
      id: randomUUID(), actorId: actorA.id, expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [candidate],
    });

    await expect(store.resources.commitSync({
      syncId: preview.id,
      candidates: [{ id: candidate.id, checksum: candidate.checksum }],
      now,
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" } satisfies Partial<SmsKitError>);
    await expect(store.resources.findTemplateByKey({ templateKey: candidate.templateKey })).resolves.toBeUndefined();

    await expect(service.importTemplate(actorA, {
      version: signature.version,
      idempotencyKey: "template:explicit-only",
      candidateId: candidate.id,
      checksum: candidate.checksum,
      templateKey: candidate.templateKey,
      purpose: candidate.purpose,
      signatureExternalKey: candidate.signatureExternalKey,
    })).resolves.toMatchObject({ templateKey: candidate.templateKey });
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
    if (!hasTemplateResourceSelection(templateCandidate)) throw new Error("selected template candidate was not created");
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
    if (!hasTemplateResourceSelection(candidate)) throw new Error("selected template candidate was not created");
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

  it("serializes an independent template import with its parent signature before sync and send locking", async () => {
    const signature = (await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0]!;
    const suffix = randomUUID().replaceAll("-", "");
    const templateKey = `notice.import-lock-${suffix}`;
    const templateCandidate = createResourceSyncCandidate({
      id: randomUUID(),
      externalKey: `aliyun:template:SMS_IMPORT_LOCK_${suffix}`,
      changeType: "new",
      checksum: `import-lock-template-${suffix}`,
      resourceType: "template",
      signatureExternalKey: signature.externalKey,
      templateKey,
      purpose: "notification",
      snapshot: {
        kind: "template",
        externalCode: `SMS_IMPORT_LOCK_${suffix}`,
        externalName: `Import lock ${suffix}`,
        externalStatus: "approved",
        templateType: "notification",
        variableNames: [],
      },
    });
    if (!hasTemplateResourceSelection(templateCandidate)) throw new Error("selected template candidate was not created");
    await store.resources.createSyncPreview({
      id: randomUUID(),
      actorId: actorA.id,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [templateCandidate],
    });
    const retiredSignature = createResourceSyncCandidate({
      id: randomUUID(),
      externalKey: signature.externalKey,
      changeType: "unavailable",
      checksum: `import-lock-signature-${suffix}`,
      resourceType: "signature",
      snapshot: {
        kind: "signature",
        externalName: signature.externalName,
        externalStatus: "unavailable",
        externalType: signature.externalType,
      },
    });
    const retiringPreview = await store.resources.createSyncPreview({
      id: randomUUID(),
      actorId: actorA.id,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [retiredSignature],
    });

    const importBarrier: QueryBarrier = {
      matches: (sql) => sql.includes("insert into sms_kit.template (") && !sql.includes("on conflict"),
      entered: deferred<void>(),
      release: deferred<void>(),
    };
    const syncBarrier: QueryBarrier = {
      matches: (sql) => sql.includes("select id from sms_kit.signature") &&
        sql.includes("order by external_key, id for update"),
      entered: deferred<void>(),
      release: deferred<void>(),
    };
    const importProbe = instrumentTransactions(store, `import-${suffix}`, importBarrier);
    const syncProbe = instrumentTransactions(store, `sync-${suffix}`, syncBarrier);
    const sendProbe = instrumentTransactions(store, `send-${suffix}`);
    const importService = new ResourceAdminService({
      store: importProbe.store,
      authorizer: { assert: () => undefined },
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
      events: { emit: () => undefined },
    });
    const sendService = new SendService({
      store: sendProbe.store,
      provider: {} as never,
      phoneProtector: {
        protect: async () => ({ ciphertext: "phone", keyId: "key-1", lookupHash: "hash", last4: "0000", masked: "***0000" }),
        unprotect: async () => normalizeMainlandPhone("13800138000"),
      },
      payloadProtector: {
        seal: async () => ({ ciphertext: "params", keyId: "key-1" }),
        open: async () => ({}),
      },
      clock: { now: () => now },
      ids: { next: () => randomUUID(), messageId: () => randomUUID() as MessageId },
      events: { emit: () => undefined },
      providerTimeoutMs: 1_000,
    });

    let importing: Promise<unknown> | undefined;
    let syncing: Promise<unknown> | undefined;
    let sending: Promise<unknown> | undefined;
    try {
      importing = importService.importTemplate(actorA, {
        version: signature.version,
        idempotencyKey: `template:import-lock:${suffix}`,
        candidateId: templateCandidate.id,
        checksum: templateCandidate.checksum,
        templateKey,
        purpose: templateCandidate.purpose,
        signatureExternalKey: signature.externalKey,
      });
      void importing.catch(() => undefined);
      await importBarrier.entered.promise;
      const importPid = await importProbe.pid;

      syncing = syncProbe.store.transaction((tx) => syncProbe.store.resources.commitSync({
        syncId: retiringPreview.id,
        candidates: retiringPreview.candidates.map(({ id, checksum }) => ({ id, checksum })),
        now,
      }, tx));
      void syncing.catch(() => undefined);
      const syncPid = await syncProbe.pid;
      await waitUntilBlockedBy(pool, syncPid, importPid, "resource sync to block behind template import");

      importBarrier.release.resolve(undefined);
      const imported = await importing;
      await syncBarrier.entered.promise;

      sending = sendService.enqueueNotification({
        tenantId: actorB.tenantId,
        templateKey,
        phone: "13800138000",
        variables: {},
        purpose: "notification",
        idempotencyKey: `send-import-lock-${suffix}`,
      });
      void sending.catch(() => undefined);
      const sendPid = await sendProbe.pid;
      await waitUntilBlockedBy(pool, sendPid, syncPid, "send to block behind resource sync");

      syncBarrier.release.resolve(undefined);
      const [syncOutcome, sendOutcome] = await Promise.allSettled([syncing, sending]);

      expect(imported).toMatchObject({ templateKey, enabled: true });
      expect(syncOutcome).toEqual(expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({ status: "succeeded" }),
      }));
      expect(sendOutcome).toEqual(expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "TEMPLATE_UNAVAILABLE" }),
      }));
      expect([...importProbe.pgCodes, ...syncProbe.pgCodes, ...sendProbe.pgCodes]).not.toContain("40P01");
      await expect(store.resources.findTemplateByKey({ templateKey })).resolves.toMatchObject({
        enabled: false,
        externalStatus: "unavailable",
      });
      await expect(pool.query<{ total: number }>(
        "select count(*)::integer as total from sms_kit.send_message where template_id = $1",
        [(imported as { id: string }).id],
      )).resolves.toMatchObject({ rows: [{ total: 0 }] });
    } finally {
      importBarrier.release.resolve(undefined);
      syncBarrier.release.resolve(undefined);
      await Promise.allSettled([importing, syncing, sending].filter((value): value is Promise<unknown> => value !== undefined));
    }
  }, 20_000);

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
