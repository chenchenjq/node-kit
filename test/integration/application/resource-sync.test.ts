import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ResourceSyncService } from "../../../src/application/resource-sync-service.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { createResourceSyncCandidate } from "../../../src/ports/store.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const actor = { id: "operator", tenantId: "tenant-a" } as AuthorizationActor;

describe("ResourceSyncService", () => {
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
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const postgres = await startPostgres();
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
    await store.resources.commitSync({ syncId: templatePreview.id, candidates: templatePreview.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });
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
    await store.resources.commitSync({ syncId: seed.id, candidates: seed.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })) });
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
});
