import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ResourceSyncService } from "../../../src/application/resource-sync-service.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const actor = { id: "operator", tenantId: "system" } as AuthorizationActor;

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

    expect(audits).toEqual([]);
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
    expect((await store.audits.list({ tenantId: actor.tenantId, page: 1, pageSize: 10 })).items).toEqual(expect.arrayContaining([
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
});
