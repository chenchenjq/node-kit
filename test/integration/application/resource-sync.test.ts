import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { ResourceSyncService } from "../../../src/application/resource-sync-service.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { createResourceSyncCandidate, hasTemplateResourceSelection } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";
import { commitResourceFixturePreview } from "../postgres/resource-fixtures.js";

const actor = { id: "operator", tenantId: "tenant-a" } as AuthorizationActor;

describe("ResourceSyncService", () => {
  it("rejects two new provider templates selected with the same stable local key", async () => {
    const sync = new ResourceSyncService({
      store: {
        config: { get: async () => ({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", status: "ready", enabled: true, lastTestStatus: "succeeded", version: 1 }) },
        resources: {
          listSignatures: async () => ({ items: [], total: 0 }),
          listTemplates: async () => ({ items: [], total: 0 }),
          createSyncPreview: async (input: { id: string; expiresAt: Date; resources: readonly never[] }) => ({ ...input, status: "running" as const, candidates: input.resources }),
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {
        listSignatures: async () => ({ items: [{ externalKey: "sign:shared", externalName: "Shared", externalStatus: "approved", externalType: "text" }] }),
        listTemplates: async () => ({ items: [
          { externalKey: "template:first", externalCode: "SMS_FIRST", externalName: "First", externalStatus: "approved", templateType: "notification", variableNames: [] },
          { externalKey: "template:second", externalCode: "SMS_SECOND", externalName: "Second", externalStatus: "approved", templateType: "notification", variableNames: [] },
        ] }),
      } as never,
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() },
      events: { emit: () => undefined },
    });

    await expect(sync.preview(actor, {
      templates: [
        { externalKey: "template:first", signatureExternalKey: "sign:shared", templateKey: "notice.duplicate", purpose: "notification" },
        { externalKey: "template:second", signatureExternalKey: "sign:shared", templateKey: "notice.duplicate", purpose: "notification" },
      ],
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("does not silently rebind an existing template while its current parent remains in the provider snapshot", async () => {
    const oldSignatureExternalKey = "sign:old-parent";
    const replacementExternalKey = "sign:replacement-parent";
    const templateExternalCode = "SMS_PARENT_STILL_PRESENT";
    const sync = new ResourceSyncService({
      store: {
        config: { get: async () => ({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", status: "ready", enabled: true, lastTestStatus: "succeeded", version: 1 }) },
        resources: {
          listSignatures: async () => ({ items: [{
            id: "00000000-0000-4000-8000-000000000001", externalKey: oldSignatureExternalKey,
            externalName: "Old parent", externalStatus: "approved", externalType: "text", enabled: true, version: 1,
          }], total: 1 }),
          listTemplates: async () => ({ items: [{
            id: "00000000-0000-4000-8000-000000000002", signatureId: "00000000-0000-4000-8000-000000000001",
            templateKey: "notice.parent-still-present", externalCode: templateExternalCode, externalName: "Parent still present",
            externalStatus: "approved", templateType: "notification", purpose: "notification", variables: [], enabled: true, version: 1,
          }], total: 1 }),
          createSyncPreview: async (input: { id: string; expiresAt: Date; resources: readonly never[] }) => ({ ...input, status: "running" as const, candidates: input.resources }),
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {
        listSignatures: async () => ({ items: [
          { externalKey: oldSignatureExternalKey, externalName: "Old parent", externalStatus: "approved", externalType: "text" },
          { externalKey: replacementExternalKey, externalName: "Replacement parent", externalStatus: "approved", externalType: "text" },
        ] }),
        listTemplates: async () => ({ items: [{
          externalKey: "template:parent-still-present", externalCode: templateExternalCode, externalName: "Parent still present",
          externalStatus: "approved", templateType: "notification", variableNames: [],
        }] }),
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });

    await expect(sync.preview(actor, {
      templates: [{
        externalKey: "template:parent-still-present", signatureExternalKey: replacementExternalKey,
        templateKey: "notice.parent-still-present", purpose: "notification",
      }],
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("requires exact candidate checksums at commit", async () => {
    const resources = new Map<string, { id: string; expiresAt: Date; candidates: readonly { id: string; checksum: string }[] }>();
    const sync = new ResourceSyncService({
      store: {
        config: { get: async () => ({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", status: "ready", enabled: true, lastTestStatus: "succeeded", version: 1 }) },
        resources: {
          listSignatures: async () => ({ items: [], total: 0 }),
          listTemplates: async () => ({ items: [], total: 0 }),
          createSyncPreview: async (input: { id: string; expiresAt: Date; resources: readonly { id: string; checksum: string }[] }) => {
            const preview = { id: input.id, status: "running" as const, expiresAt: input.expiresAt, candidates: input.resources };
            resources.set(input.id, preview);
            return preview;
          },
          commitSync: async (input: { syncId: string; candidates: readonly { id: string; checksum: string }[] }) => {
            const preview = resources.get(input.syncId);
            if (preview === undefined || input.candidates.some((candidate) => preview.candidates.find((saved) => saved.id === candidate.id)?.checksum !== candidate.checksum)) {
              throw new SmsKitError("CONCURRENT_MODIFICATION", "resource preview checksum changed");
            }
            return { ...preview, status: "succeeded" as const };
          },
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {
        listSignatures: async () => ({ items: [{ externalKey: "sign-1", externalName: "Production", externalStatus: "approved", externalType: "text" }] }),
        listTemplates: async () => ({ items: [] }),
      } as never,
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => "00000000-0000-4000-8000-000000000001" },
      events: { emit: () => undefined },
    });

    const preview = await sync.preview(actor);

    await expect(sync.commit(actor, {
      syncId: preview.id,
      candidates: [{ id: preview.candidates[0]!.id, checksum: "wrong" }],
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
  });

  it("does not let an expired preview import resources and appends an audit only for a commit", async () => {
    let now = new Date("2026-09-13T00:00:00.000Z");
    const audits: unknown[] = [];
    const previews = new Map<string, { id: string; expiresAt: Date; candidates: readonly { id: string; checksum: string }[] }>();
    let id = 0;
    const sync = new ResourceSyncService({
      store: {
        config: { get: async () => ({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", status: "ready", enabled: true, lastTestStatus: "succeeded", version: 1 }) },
        resources: {
          listSignatures: async () => ({ items: [], total: 0 }), listTemplates: async () => ({ items: [], total: 0 }),
          createSyncPreview: async (input: { id: string; expiresAt: Date; resources: readonly { id: string; checksum: string }[] }) => {
            const preview = { id: input.id, expiresAt: input.expiresAt, candidates: input.resources }; previews.set(input.id, preview);
            return { ...preview, status: "running" as const };
          },
          commitSync: async (input: { syncId: string; now?: Date; candidates: readonly { id: string; checksum: string }[] }) => {
            const preview = previews.get(input.syncId);
            if (preview === undefined || preview.expiresAt <= input.now!) throw new SmsKitError("CONCURRENT_MODIFICATION", "resource preview is no longer current");
            return { ...preview, status: "succeeded" as const };
          },
        },
        audits: { append: async (event: unknown) => { audits.push(event); return event; } },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {
        listSignatures: async () => ({ items: [{ externalKey: "sign-1", externalName: "Production", externalStatus: "approved", externalType: "text" }] }),
        listTemplates: async () => ({ items: [] }),
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => now },
      ids: { next: () => `00000000-0000-4000-8000-00000000000${++id}` }, events: { emit: () => undefined },
    });

    const preview = await sync.preview(actor);
    now = new Date(preview.expiresAt.getTime());
    await expect(sync.commit(actor, { syncId: preview.id, candidates: [{ id: preview.candidates[0]!.id, checksum: preview.candidates[0]!.checksum }] }))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    expect(audits).toEqual([expect.objectContaining({ action: "resource.sync.preview", result: "succeeded" })]);
  });
});

describe("ResourceSyncService with PostgreSQL", () => {
  let store: PgSmsStore;
  let pool: Pool;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(postgres.pool);
    store = new PgSmsStore(postgres.pool);
    const configured = await store.config.update({
      provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET",
      receiptCallbackTokenRef: "env://TOKEN", enabled: true, expectedVersion: 0,
    });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date("2026-09-13T00:00:00.000Z"), expectedVersion: configured.version });
  }, 120_000);

  afterAll(async () => stop?.());

  it("commits only an approved, checksum-bound snapshot and records the audit event", async () => {
    const now = new Date("2026-09-13T00:00:00.000Z");
    const sync = new ResourceSyncService({
      store,
      provider: {
        listSignatures: async () => ({ items: [{ externalKey: "aliyun:sign:approved", externalName: "Approved", externalStatus: "AUDIT_STATE_PASS", externalType: "通用类型" }] }),
        listTemplates: async () => ({ items: [] }),
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => now },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });

    const preview = await sync.preview(actor);
    const committed = await sync.commit(actor, { syncId: preview.id, candidates: preview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });

    expect(committed.status).toBe("succeeded");
    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).items).toHaveLength(1);
    expect((await store.audits.list({ tenantId: "__system__" as AuthorizationActor["tenantId"], page: 1, pageSize: 10 })).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "resource.sync.commit", targetId: preview.id, result: "succeeded" }),
    ]));
  });

  it("replays versioned preview and commit requests without rediscovering or recommitting resources", async () => {
    const config = await store.config.get();
    if (config.status === "unconfigured") throw new Error("resource-sync configuration is missing");
    const externalKey = `aliyun:sign:replay-${crypto.randomUUID()}`;
    let signatureReads = 0;
    let templateReads = 0;
    const sync = new ResourceSyncService({
      store,
      provider: {
        listSignatures: async () => {
          signatureReads += 1;
          return { items: [
            { externalKey: "aliyun:sign:approved", externalName: "Approved", externalStatus: "AUDIT_STATE_PASS", externalType: "通用类型" },
            { externalKey, externalName: "Replay", externalStatus: "AUDIT_STATE_PASS", externalType: "通用类型" },
          ] };
        },
        listTemplates: async () => {
          templateReads += 1;
          return { items: [] };
        },
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });
    const previewInput = { expectedVersion: config.version, idempotencyKey: "sync:versioned-preview" };

    const preview = await sync.preview(actor, previewInput as never);
    const replayedPreview = await sync.preview(actor, previewInput as never);

    expect(replayedPreview).toEqual(preview);
    expect({ signatureReads, templateReads }).toEqual({ signatureReads: 1, templateReads: 1 });
    await expect(sync.preview(actor, { ...previewInput, pageSize: 1 } as never)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(sync.preview(actor, { expectedVersion: config.version - 1, idempotencyKey: "sync:stale-preview" } as never)).rejects.toMatchObject({
      code: "CONCURRENT_MODIFICATION",
    });

    const commitInput = {
      expectedVersion: config.version,
      idempotencyKey: "sync:versioned-commit",
      syncId: preview.id,
      candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })),
    };
    const committed = await sync.commit(actor, commitInput as never);
    const replayedCommit = await sync.commit(actor, commitInput as never);

    expect(replayedCommit).toEqual(committed);
    await expect(sync.commit(actor, {
      ...commitInput,
      candidates: commitInput.candidates.map((candidate) => ({ ...candidate, checksum: "changed" })),
    } as never)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects an unapproved provider snapshot without importing it", async () => {
    const sync = new ResourceSyncService({
      store,
      provider: {
        listSignatures: async () => ({ items: [{ externalKey: "aliyun:sign:rejected", externalName: "Rejected", externalStatus: "AUDIT_STATE_NOT_PASS", externalType: "通用类型" }] }),
        listTemplates: async () => ({ items: [] }),
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });

    const preview = await sync.preview(actor);
    await expect(sync.commit(actor, { syncId: preview.id, candidates: preview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });

    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).items.map((signature) => signature.externalKey)).not.toContain("aliyun:sign:rejected");
  });

  it("creates unavailable candidates for removed local resources and disables them on commit", async () => {
    const signatures = await store.resources.listSignatures({ page: 1, pageSize: 10 });
    const signature = signatures.items.find((item) => item.externalKey === "aliyun:sign:approved");
    if (signature === undefined) throw new Error("approved signature fixture missing");
    const templatePreview = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [createResourceSyncCandidate({
        id: crypto.randomUUID(), externalKey: "aliyun:template:removed", changeType: "new", checksum: "seed-template",
        resourceType: "template", signatureExternalKey: signature.externalKey, templateKey: "notice.removed", purpose: "removed",
        snapshot: { kind: "template", externalCode: "SMS_REMOVED", externalName: "Removed", externalStatus: "approved", templateType: "notification", variableNames: [] },
      })],
    });
    await commitResourceFixturePreview(store, templatePreview);
    const sync = new ResourceSyncService({
      store,
      provider: { listSignatures: async () => ({ items: [] }), listTemplates: async () => ({ items: [] }) } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });

    const preview = await sync.preview(actor);
    expect(preview.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "signature", externalKey: "aliyun:sign:approved", changeType: "unavailable" }),
      expect.objectContaining({ resourceType: "template", externalKey: "aliyun:template:SMS_REMOVED", changeType: "unavailable" }),
    ]));
    await sync.commit(actor, { syncId: preview.id, candidates: preview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });

    expect((await store.resources.listSignatures({ page: 1, pageSize: 10 })).items.find((item) => item.id === signature.id)).toMatchObject({ enabled: false, externalStatus: "unavailable" });
    expect((await store.resources.findTemplateByKey({ templateKey: "notice.removed" }))).toMatchObject({ enabled: false, externalStatus: "unavailable" });
  });

  it("retires templates when their signature disappears even if the template remains in the provider snapshot", async () => {
    const signature = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: "aliyun:sign:retired-parent", changeType: "new", checksum: "retired-signature",
      resourceType: "signature", snapshot: { kind: "signature", externalName: "Retired parent", externalStatus: "approved", externalType: "通用类型" },
    });
    const template = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: "aliyun:template:SMS_STILL_LISTED", changeType: "new", checksum: "still-listed-template",
      resourceType: "template", signatureExternalKey: signature.externalKey, templateKey: "notice.still-listed", purpose: "still-listed",
      snapshot: { kind: "template", externalCode: "SMS_STILL_LISTED", externalName: "Still listed", externalStatus: "approved", templateType: "notification", variableNames: [] },
    });
    const seed = await store.resources.createSyncPreview({ id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template] });
    await commitResourceFixturePreview(store, seed);
    const sync = new ResourceSyncService({
      store,
      provider: {
        listSignatures: async () => ({ items: [] }),
        listTemplates: async () => ({ items: [{ externalKey: "aliyun:template:SMS_STILL_LISTED", externalCode: "SMS_STILL_LISTED", externalName: "Still listed", externalStatus: "approved", templateType: "notification", variableNames: [] }] }),
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });

    const preview = await sync.preview(actor);
    expect(preview.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalKey: signature.externalKey, resourceType: "signature", changeType: "unavailable" }),
    ]));
    expect(preview.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ externalKey: template.externalKey, resourceType: "template" }),
    ]));
    await sync.commit(actor, { syncId: preview.id, candidates: preview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });

    expect((await store.resources.findTemplateByKey({ templateKey: "notice.still-listed" }))).toMatchObject({ enabled: false, externalStatus: "unavailable" });
  });

  it("rejects a selected approved template when its signature is unavailable", async () => {
    const unavailableSignature = (await store.resources.listSignatures({ page: 1, pageSize: 20 })).items
      .find((item) => item.externalKey === "aliyun:sign:retired-parent");
    if (unavailableSignature === undefined) throw new Error("retired signature fixture missing");
    const preview = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [createResourceSyncCandidate({
        id: crypto.randomUUID(), externalKey: "aliyun:template:SMS_BLOCKED", changeType: "new", checksum: "blocked-template",
        resourceType: "template", signatureExternalKey: unavailableSignature.externalKey, templateKey: "notice.blocked", purpose: "blocked",
        snapshot: { kind: "template", externalCode: "SMS_BLOCKED", externalName: "Blocked", externalStatus: "approved", templateType: "notification", variableNames: [] },
      })],
    });

    await expect(store.resources.commitSync({ syncId: preview.id, candidates: preview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await store.resources.findTemplateByKey({ templateKey: "notice.blocked" })).toBeUndefined();
  });

  it.each([
    { name: "absent from the current provider snapshot", key: "missing", discovered: false, enabled: true, status: "approved" },
    { name: "locally disabled despite current cloud approval", key: "disabled", discovered: true, enabled: false, status: "approved" },
    { name: "no longer cloud-approved despite local approval", key: "rejected", discovered: true, enabled: true, status: "AUDIT_STATE_NOT_PASS" },
  ])("rejects template selection before persisting a batch when its signature is $name", async ({ key, discovered, enabled, status }) => {
    const externalKey = `aliyun:sign:selection-${key}`;
    const signature = { externalKey, externalName: key, externalStatus: status, externalType: "通用类型" };
    const templateKey = `notice.selection-${key}`;
    const template = { externalKey: `aliyun:template:SMS_SELECTION_${key}`, externalCode: `SMS_SELECTION_${key}`, externalName: key, externalStatus: "approved", templateType: "notification", variableNames: [] };
    const seed = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [createResourceSyncCandidate({
        id: crypto.randomUUID(), externalKey, changeType: "new", checksum: `seed-${key}`, resourceType: "signature",
        snapshot: { kind: "signature", externalName: key, externalStatus: "approved", externalType: "通用类型" },
      })],
    });
    await store.resources.commitSync({ syncId: seed.id, candidates: seed.candidates.map(({ id, checksum }) => ({ id, checksum })) });
    if (!enabled) await pool.query("update sms_kit.signature set enabled = false where external_key = $1", [externalKey]);
    const sync = new ResourceSyncService({
      store,
      provider: {
        listSignatures: async () => ({ items: discovered ? [signature] : [] }),
        listTemplates: async () => ({ items: [template] }),
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });
    const batchesBefore = (await pool.query("select count(*) from sms_kit.resource_sync")).rows;

    await expect(sync.preview(actor, { templates: [{ externalKey: template.externalKey, signatureExternalKey: externalKey, templateKey, purpose: "notification" }] }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });

    expect((await pool.query("select count(*) from sms_kit.resource_sync")).rows).toEqual(batchesBefore);
    expect(await store.resources.findTemplateByKey({ templateKey })).toBeUndefined();
  });

  it("discovers a new template without a mapping, then refreshes it only after explicit import", async () => {
    const signature = { externalKey: "aliyun:sign:selection-usable", externalName: "Usable", externalStatus: "AUDIT_STATE_PASS", externalType: "通用类型" };
    let externalName = "Usable";
    const template = () => ({ externalKey: "aliyun:template:SMS_USABLE", externalCode: "SMS_USABLE", externalName, externalStatus: "approved", templateType: "notification", variableNames: [] });
    const sync = new ResourceSyncService({
      store,
      provider: { listSignatures: async () => ({ items: [signature] }), listTemplates: async () => ({ items: [template()] }) } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });

    const preview = await sync.preview(actor);
    const signatureCandidate = preview.candidates.find((candidate) => candidate.resourceType === "signature" && candidate.externalKey === signature.externalKey);
    const templateCandidate = preview.candidates.find((candidate) => candidate.resourceType === "template" && candidate.externalKey === template().externalKey);
    if (signatureCandidate === undefined || templateCandidate === undefined || templateCandidate.resourceType !== "template") {
      throw new Error("new resource candidates are missing");
    }
    expect(hasTemplateResourceSelection(templateCandidate)).toBe(false);
    await sync.commit(actor, { syncId: preview.id, candidates: [{ id: signatureCandidate.id, checksum: signatureCandidate.checksum }] });
    const importedSignature = (await store.resources.listSignatures({ page: 1, pageSize: 100 })).items.find((item) => item.externalKey === signature.externalKey)!;
    await store.transaction((tx) => store.resources.importTemplate({
      candidateId: templateCandidate.id,
      checksum: templateCandidate.checksum,
      templateKey: "notice.usable",
      purpose: "notification",
      signatureExternalKey: signature.externalKey,
      expectedSignatureVersion: importedSignature.version,
      now: new Date("2026-09-13T00:00:00.000Z"),
    }, tx));

    externalName = "Usable refreshed";
    const refresh = await sync.preview(actor);
    const changed = refresh.candidates.find((candidate) => candidate.resourceType === "template" && candidate.externalKey === template().externalKey);
    expect(changed).toMatchObject({ changeType: "changed", templateKey: "notice.usable", purpose: "notification" });
    await expect(sync.commit(actor, {
      syncId: refresh.id,
      candidates: refresh.candidates.map(({ id, checksum }) => ({ id, checksum })),
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(store.resources.findTemplateByKey({ templateKey: "notice.usable" }))
      .resolves.toMatchObject({ enabled: true, externalName });
  });

  it("keeps a preview runnable after a subset commit until every candidate is committed", async () => {
    const suffix = crypto.randomUUID();
    const signature = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:sign:subset-${suffix}`, changeType: "new", checksum: `subset-signature-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: `Subset ${suffix}`, externalStatus: "approved", externalType: "通用类型",
      },
    });
    const template = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:template:SUBSET_${suffix}`, changeType: "new", checksum: `subset-template-${suffix}`,
      resourceType: "template", signatureExternalKey: signature.externalKey,
      templateKey: `notice.subset-${suffix}`, purpose: "notification",
      snapshot: {
        kind: "template", externalCode: `SMS_SUBSET_${suffix}`, externalName: `Subset ${suffix}`,
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    const preview = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "subset", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template],
    });

    const first = await store.resources.commitSync({
      syncId: preview.id,
      candidates: [{ id: signature.id, checksum: signature.checksum }],
    });

    expect(first.status).toBe("running");
    await expect(pool.query<{ status: string; committed: number }>(
      `select s.status, count(c.*) filter (where c.committed_at is not null)::integer as committed
         from sms_kit.resource_sync s
         join sms_kit.resource_sync_candidate c on c.sync_id = s.id
        where s.id = $1
        group by s.status`,
      [preview.id],
    )).resolves.toMatchObject({ rows: [{ status: "running", committed: 1 }] });

    const persistedSignature = await store.resources.findSignatureById({ id: signature.id });
    if (persistedSignature === undefined || !hasTemplateResourceSelection(template)) throw new Error("subset fixture is invalid");
    await store.transaction((tx) => store.resources.importTemplate({
      candidateId: template.id,
      checksum: template.checksum,
      templateKey: template.templateKey,
      purpose: template.purpose,
      signatureExternalKey: template.signatureExternalKey,
      expectedSignatureVersion: persistedSignature.version,
      now: new Date("2026-09-14T00:00:00.000Z"),
    }, tx));

    await expect(pool.query("select status from sms_kit.resource_sync where id = $1", [preview.id]))
      .resolves.toMatchObject({ rows: [{ status: "succeeded" }] });
  });

  it("serializes conflicting explicit imports for the same newly discovered template", async () => {
    const suffix = crypto.randomUUID();
    const signature = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:sign:selection-race-${suffix}`, changeType: "new", checksum: `selection-signature-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: `Selection race ${suffix}`, externalStatus: "approved", externalType: "通用类型",
      },
    });
    const seed = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature],
    });
    await commitResourceFixturePreview(store, seed);
    const externalCode = `SMS_SELECTION_RACE_${suffix}`;
    const candidate = (templateKey: string, checksum: string) => createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:template:${externalCode}`, changeType: "new", checksum,
      resourceType: "template", signatureExternalKey: signature.externalKey, templateKey, purpose: "notification",
      snapshot: {
        kind: "template", externalCode, externalName: `Selection race ${suffix}`,
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    const firstCandidate = candidate(`notice.selection-race-a-${suffix}`, `selection-a-${suffix}`);
    const secondCandidate = candidate(`notice.selection-race-b-${suffix}`, `selection-b-${suffix}`);
    const [firstPreview, secondPreview] = await Promise.all([
      store.resources.createSyncPreview({
        id: crypto.randomUUID(), actorId: "first", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [firstCandidate],
      }),
      store.resources.createSyncPreview({
        id: crypto.randomUUID(), actorId: "second", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [secondCandidate],
      }),
    ]);

    const importedSignature = await store.resources.findSignatureById({ id: signature.id });
    if (importedSignature === undefined || !hasTemplateResourceSelection(firstCandidate) || !hasTemplateResourceSelection(secondCandidate)) {
      throw new Error("explicit import race fixture is invalid");
    }
    const importCandidate = (value: typeof firstCandidate) => store.transaction((tx) => store.resources.importTemplate({
      candidateId: value.id,
      checksum: value.checksum,
      templateKey: value.templateKey,
      purpose: value.purpose,
      signatureExternalKey: value.signatureExternalKey,
      expectedSignatureVersion: importedSignature.version,
      now: new Date("2026-09-14T00:00:00.000Z"),
    }, tx));
    const outcomes = await Promise.allSettled([importCandidate(firstCandidate), importCandidate(secondCandidate)]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONCURRENT_MODIFICATION" }) }),
    ]);
    await expect(pool.query<{ total: string }>(
      "select count(*)::text as total from sms_kit.template where external_code = $1",
      [externalCode],
    )).resolves.toMatchObject({ rows: [{ total: "1" }] });
  });

  it("preserves an existing template parent signature instead of accepting a stale rebind", async () => {
    const suffix = crypto.randomUUID();
    const firstSignature = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:sign:parent-first-${suffix}`, changeType: "new", checksum: `parent-first-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: `Parent first ${suffix}`, externalStatus: "approved", externalType: "通用类型",
      },
    });
    const secondSignature = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:sign:parent-second-${suffix}`, changeType: "new", checksum: `parent-second-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: `Parent second ${suffix}`, externalStatus: "approved", externalType: "通用类型",
      },
    });
    const templateKey = `notice.parent-${suffix}`;
    const externalCode = `SMS_PARENT_${suffix}`;
    const template = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:template:${externalCode}`, changeType: "new", checksum: `parent-template-${suffix}`,
      resourceType: "template", signatureExternalKey: firstSignature.externalKey, templateKey, purpose: "notification",
      snapshot: {
        kind: "template", externalCode, externalName: `Parent ${suffix}`,
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    const seed = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      resources: [firstSignature, secondSignature, template],
    });
    await commitResourceFixturePreview(store, seed);
    const original = await store.resources.findTemplateByKey({ templateKey });
    if (original === undefined) throw new Error("parent template missing");

    const staleChange = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:template:${externalCode}`, changeType: "changed", checksum: `parent-stale-${suffix}`,
      resourceType: "template", signatureExternalKey: secondSignature.externalKey, templateKey, purpose: "notification",
      snapshot: {
        kind: "template", externalCode, externalName: `Parent changed ${suffix}`,
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    const stalePreview = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "stale", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [staleChange],
    });

    await expect(store.resources.commitSync({
      syncId: stalePreview.id,
      candidates: stalePreview.candidates.map(({ id, checksum }) => ({ id, checksum })),
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
    await expect(store.resources.findTemplateByKey({ templateKey })).resolves.toMatchObject({ signatureId: original.signatureId });
  });

  it("serializes cross-ordered new signature identities without exposing a database deadlock", async () => {
    const suffix = crypto.randomUUID();
    const signature = (externalKey: string, externalName: string, checksum: string) => createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey, changeType: "new", checksum,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName, externalStatus: "approved", externalType: "通用类型",
      },
    });
    const nameOne = `Cross one ${suffix}`;
    const nameTwo = `Cross two ${suffix}`;
    const firstResources = [
      signature(`aliyun:sign:cross-a1-${suffix}`, nameOne, `cross-a1-${suffix}`),
      signature(`aliyun:sign:cross-a2-${suffix}`, nameTwo, `cross-a2-${suffix}`),
    ];
    const secondResources = [
      signature(`aliyun:sign:cross-b1-${suffix}`, nameTwo, `cross-b1-${suffix}`),
      signature(`aliyun:sign:cross-b2-${suffix}`, nameOne, `cross-b2-${suffix}`),
    ];
    const [firstPreview, secondPreview] = await Promise.all([
      store.resources.createSyncPreview({
        id: crypto.randomUUID(), actorId: "first", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: firstResources,
      }),
      store.resources.createSyncPreview({
        id: crypto.randomUUID(), actorId: "second", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: secondResources,
      }),
    ]);

    const outcomes = await Promise.allSettled([
      store.resources.commitSync({ syncId: firstPreview.id, candidates: firstPreview.candidates.map(({ id, checksum }) => ({ id, checksum })) }),
      store.resources.commitSync({ syncId: secondPreview.id, candidates: secondPreview.candidates.map(({ id, checksum }) => ({ id, checksum })) }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "CONCURRENT_MODIFICATION" }) }),
    ]);
  });

  it("atomically swaps existing signature name/type identities in one provider refresh", async () => {
    const suffix = crypto.randomUUID();
    const externalKeyA = `aliyun:sign:swap-a-${suffix}`;
    const externalKeyB = `aliyun:sign:swap-b-${suffix}`;
    const externalType = "通用类型";
    const nameA = `Swap A ${suffix}`;
    const nameB = `Swap B ${suffix}`;
    const candidate = (externalKey: string, externalName: string, changeType: "new" | "changed", checksum: string) =>
      createResourceSyncCandidate({
        id: crypto.randomUUID(), externalKey, changeType, checksum,
        resourceType: "signature", snapshot: {
          kind: "signature", externalName, externalStatus: "approved", externalType,
        },
      });
    const initialA = candidate(externalKeyA, nameA, "new", `swap-initial-a-${suffix}`);
    const initialB = candidate(externalKeyB, nameB, "new", `swap-initial-b-${suffix}`);
    const initialPreview = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [initialA, initialB],
    });
    await store.resources.commitSync({
      syncId: initialPreview.id,
      candidates: initialPreview.candidates.map(({ id, checksum }) => ({ id, checksum })),
    });

    const swappedA = candidate(externalKeyA, nameB, "changed", `swap-changed-a-${suffix}`);
    const swappedB = candidate(externalKeyB, nameA, "changed", `swap-changed-b-${suffix}`);
    const swappedPreview = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "refresh", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [swappedA, swappedB],
    });

    await expect(store.resources.commitSync({
      syncId: swappedPreview.id,
      candidates: swappedPreview.candidates.map(({ id, checksum }) => ({ id, checksum })),
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(pool.query<{ external_key: string; external_name: string }>(
      "select external_key, external_name from sms_kit.signature where external_key = any($1::text[]) order by external_key",
      [[externalKeyA, externalKeyB]],
    )).resolves.toMatchObject({ rows: [
      { external_key: externalKeyA, external_name: nameB },
      { external_key: externalKeyB, external_name: nameA },
    ] });
  });

  it("allows an unavailable signature to be recreated under a new external key", async () => {
    const suffix = crypto.randomUUID();
    const externalType = "通用类型";
    const externalName = `Recreated ${suffix}`;
    const oldExternalKey = `aliyun:sign:recreate-old-${suffix}`;
    const newExternalKey = `aliyun:sign:recreate-new-${suffix}`;
    const initial = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: oldExternalKey, changeType: "new", checksum: `recreate-initial-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName, externalStatus: "approved", externalType,
      },
    });
    const initialPreview = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [initial],
    });
    await store.resources.commitSync({
      syncId: initialPreview.id,
      candidates: initialPreview.candidates.map(({ id, checksum }) => ({ id, checksum })),
    });

    const retired = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: oldExternalKey, changeType: "unavailable", checksum: `recreate-retired-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName, externalStatus: "unavailable", externalType,
      },
    });
    const recreated = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: newExternalKey, changeType: "new", checksum: `recreate-new-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName, externalStatus: "approved", externalType,
      },
    });
    const refresh = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "refresh", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [retired, recreated],
    });

    await expect(store.resources.commitSync({
      syncId: refresh.id,
      candidates: refresh.candidates.map(({ id, checksum }) => ({ id, checksum })),
    })).resolves.toMatchObject({ status: "succeeded" });
    await expect(pool.query<{ external_key: string; external_status: string; enabled: boolean }>(
      "select external_key, external_status, enabled from sms_kit.signature where external_key = any($1::text[]) order by external_key",
      [[newExternalKey, oldExternalKey]],
    )).resolves.toMatchObject({ rows: [
      { external_key: newExternalKey, external_status: "approved", enabled: true },
      { external_key: oldExternalKey, external_status: "unavailable", enabled: false },
    ] });
  });

  it("does not let resource sync rebind a template when its parent signature is replaced", async () => {
    const suffix = crypto.randomUUID();
    const oldSignatureExternalKey = `aliyun:sign:rebind-old-${suffix}`;
    const newSignatureExternalKey = `aliyun:sign:rebind-new-${suffix}`;
    const templateExternalCode = `SMS_REBIND_${suffix}`;
    const templateKey = `notice.rebind-${suffix}`;
    const externalName = `Rebind ${suffix}`;
    const oldSignature = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: oldSignatureExternalKey, changeType: "new", checksum: `rebind-old-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName, externalStatus: "approved", externalType: "通用类型",
      },
    });
    const template = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:template:${templateExternalCode}`, changeType: "new", checksum: `rebind-template-${suffix}`,
      resourceType: "template", signatureExternalKey: oldSignatureExternalKey, templateKey, purpose: "notification",
      snapshot: {
        kind: "template", externalCode: templateExternalCode, externalName,
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    const seeded = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [oldSignature, template],
    });
    await commitResourceFixturePreview(store, seeded);
    const original = await store.resources.findTemplateByKey({ templateKey });
    if (original === undefined) throw new Error("seed template is missing");

    const sync = new ResourceSyncService({
      store,
      provider: {
        listSignatures: async () => ({ items: [{
          externalKey: newSignatureExternalKey, externalName, externalStatus: "approved", externalType: "通用类型",
        }] }),
        listTemplates: async () => ({ items: [{
          externalKey: template.externalKey, externalCode: templateExternalCode, externalName,
          externalStatus: "approved", templateType: "notification", variableNames: [],
        }] }),
      } as never,
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => crypto.randomUUID() }, events: { emit: () => undefined },
    });
    const preview = await sync.preview(actor);

    const retiredParent = preview.candidates.find((candidate) =>
      candidate.resourceType === "signature" && candidate.externalKey === oldSignatureExternalKey && candidate.changeType === "unavailable",
    );
    if (retiredParent === undefined) throw new Error("retired parent candidate is missing");
    await expect(sync.commit(actor, {
      syncId: preview.id,
      candidates: preview.candidates.map(({ id, checksum }) => ({ id, checksum })),
    })).resolves.toMatchObject({ status: "succeeded" });
    const unchangedParent = await store.resources.findTemplateByKey({ templateKey });
    const replacement = (await store.resources.listSignatures({ page: 1, pageSize: 100 })).items
      .find((signature) => signature.externalKey === newSignatureExternalKey);
    expect(unchangedParent).toMatchObject({ signatureId: original.signatureId, enabled: false, externalStatus: "unavailable", templateKey });
    expect(replacement).toMatchObject({ enabled: true, externalStatus: "approved" });
  });

  it("locks affected templates before signatures during a sync commit", async () => {
    const suffix = crypto.randomUUID();
    const externalKey = `aliyun:sign:lock-order-${suffix}`;
    const templateKey = `notice.lock-order-${suffix}`;
    const signature = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey, changeType: "new", checksum: `lock-signature-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: "Lock order", externalStatus: "approved", externalType: "通用类型",
      },
    });
    const template = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey: `aliyun:template:LOCK_ORDER_${suffix}`, changeType: "new", checksum: `lock-template-${suffix}`,
      resourceType: "template", signatureExternalKey: externalKey, templateKey, purpose: "notification",
      snapshot: {
        kind: "template", externalCode: `SMS_LOCK_ORDER_${suffix}`, externalName: "Lock order",
        externalStatus: "approved", templateType: "notification", variableNames: [],
      },
    });
    const seed = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "seed", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, template],
    });
    await commitResourceFixturePreview(store, seed);
    const changed = createResourceSyncCandidate({
      id: crypto.randomUUID(), externalKey, changeType: "unavailable", checksum: `lock-change-${suffix}`,
      resourceType: "signature", snapshot: {
        kind: "signature", externalName: "Lock order refreshed", externalStatus: "unavailable", externalType: "通用类型",
      },
    });
    const update = await store.resources.createSyncPreview({
      id: crypto.randomUUID(), actorId: "sync", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [changed],
    });

    let templateLocked!: () => void;
    let releaseTemplate!: () => void;
    const locked = new Promise<void>((resolve) => { templateLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseTemplate = resolve; });
    const holdingTemplate = store.transaction(async (tx) => {
      await store.resources.findTemplateByKey({ templateKey }, tx);
      templateLocked();
      await release;
    });
    await locked;
    const committing = store.resources.commitSync({
      syncId: update.id, candidates: update.candidates.map(({ id, checksum }) => ({ id, checksum })),
    });

    try {
      // Give the concurrent transaction time to reach its first resource lock.
      // A broken implementation updates the signature then blocks on this held
      // template row; the correct order blocks before taking a signature write
      // lock.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const signatureWriteLock = await pool.query<{ locked: boolean }>(`select exists (
        select 1 from pg_locks
         where relation = 'sms_kit.signature'::regclass
           and mode = 'RowExclusiveLock' and granted
      ) as locked`);
      expect(signatureWriteLock.rows[0]?.locked).toBe(false);

      const reader = await pool.connect();
      try {
        await reader.query("begin");
        await reader.query("set local lock_timeout = '250ms'");
        // This mirrors the send path's second shared resource lock. If sync
        // first locked the signature and then waited for the template, this
        // would time out and a real send would form a deadlock cycle.
        await expect(reader.query(
          "select id from sms_kit.signature where external_key = $1 for share",
          [externalKey],
        )).resolves.toBeDefined();
        await reader.query("rollback");
      } finally {
        reader.release();
      }
    } finally {
      releaseTemplate();
    }
    await expect(holdingTemplate).resolves.toBeUndefined();
    await expect(committing).resolves.toMatchObject({ status: "succeeded" });
  });
});
