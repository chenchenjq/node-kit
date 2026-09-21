import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.mock("server-only", () => ({}));

import { ResourceAdminService } from "../../../src/application/resource-admin-service.js";
import { ResourceSyncService } from "../../../src/application/resource-sync-service.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { TenantId } from "../../../src/core/types.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { createSmsAdminHandler } from "../../../src/next/index.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const actor = {
  id: "resource-route-admin", tenantId: "tenant-resource-route" as TenantId, permissions: ["resource.sync", "template.manage"],
} as AuthorizationActor;
const now = new Date("2026-09-14T00:00:00.000Z");

describe("resource sync routes with PostgreSQL", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: Pool;
  let store: PgSmsStore;
  let sync: ResourceSyncService<AuthorizationActor>;
  let resources: ResourceAdminService<AuthorizationActor>;
  let providerReads: number;

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    pool = postgres.pool;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
  }, 120_000);

  afterAll(async () => stop?.());

  beforeEach(async () => {
    await pool.query(`truncate table
      sms_kit.admin_operation, sms_kit.audit_event, sms_kit.send_job, sms_kit.send_attempt,
      sms_kit.delivery_receipt, sms_kit.send_message, sms_kit.resource_sync_candidate,
      sms_kit.resource_sync, sms_kit.template, sms_kit.signature, sms_kit.provider_config cascade`);
    providerReads = 0;
    const configured = await store.config.update({
      provider: "aliyun", region: "cn-shanghai", endpoint: "https://sms.example.test",
      accessKeyIdRef: "env://RESOURCE_ROUTE_ID", accessKeySecretRef: "env://RESOURCE_ROUTE_SECRET",
      receiptCallbackTokenRef: "env://RESOURCE_ROUTE_CALLBACK", enabled: true, expectedVersion: 0,
    });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: now, expectedVersion: configured.version });
    sync = new ResourceSyncService({
      store,
      provider: {
        listSignatures: async () => {
          providerReads += 1;
          return { items: [{ externalKey: "aliyun:sign:resource-route", externalName: "Route signature", externalStatus: "approved", externalType: "text" }] };
        },
        listTemplates: async () => ({ items: [{
          externalKey: "aliyun:template:SMS_RESOURCE_ROUTE",
          externalCode: "SMS_RESOURCE_ROUTE",
          externalName: "Route notification",
          externalStatus: "approved",
          templateType: "notification",
          variableNames: ["orderNo"],
          templateContent: "Order ${orderNo}; private provider body",
          providerSecret: "provider-secret-must-not-leak",
        }] }),
      } as never,
      authorizer: { assert: () => undefined },
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
      events: { emit: () => undefined },
    });
    resources = new ResourceAdminService({
      store,
      authorizer: { assert: () => undefined },
      clock: { now: () => now },
      ids: { next: () => randomUUID() },
      events: { emit: () => undefined },
    });
  });

  function handler() {
    return createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.20",
      authorizer: {
        assert: (candidate, permission) => {
          if (!(candidate.permissions ?? []).includes(permission)) throw new SmsKitError("PERMISSION_DENIED", "not allowed");
        },
        assertAny: () => undefined,
      },
      services: { task3: { resourceSync: sync, resources } },
      ids: { next: () => randomUUID(), messageId: () => randomUUID() as never },
    });
  }

  async function post(path: string, body: unknown) {
    return handler()(new Request(`https://app.test/api/admin/sms${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
  }

  it("persists route version/idempotency metadata and replays preview/commit without repeated provider or mutation work", async () => {
    const config = await store.config.get();
    if (config.status === "unconfigured") throw new Error("resource route configuration is missing");
    const previewInput = { version: config.version, idempotencyKey: "route:preview" };
    const preview = await post("/resources/sync-preview", previewInput);
    const previewBody = await preview.json();
    expect(preview.status).toBe(200);
    const replayedPreview = await post("/resources/sync-preview", previewInput);
    expect(replayedPreview.status).toBe(200);
    expect(await replayedPreview.json()).toMatchObject({ data: previewBody.data });
    expect(providerReads).toBe(1);

    const commitInput = {
      version: config.version,
      idempotencyKey: "route:commit",
      syncId: previewBody.data.id,
      candidates: previewBody.data.candidates
        .filter(({ resourceType }: { resourceType: string }) => resourceType === "signature")
        .map(({ id, checksum }: { id: string; checksum: string }) => ({ id, checksum })),
    };
    const committed = await post("/resources/sync-commit", commitInput);
    expect(committed.status).toBe(200);
    const committedBody = await committed.json();
    const replayedCommit = await post("/resources/sync-commit", commitInput);
    expect(replayedCommit.status).toBe(200);
    expect(await replayedCommit.json()).toMatchObject({ data: committedBody.data });
    await expect(store.resources.listSignatures({ page: 1, pageSize: 10 })).resolves.toMatchObject({ total: 1 });
    await expect(pool.query("select operation, count(*)::integer as count from sms_kit.admin_operation where tenant_id = $1 group by operation order by operation", [actor.tenantId]))
      .resolves.toMatchObject({ rows: [
        { operation: "resource.sync.commit", count: 1 },
        { operation: "resource.sync.preview", count: 1 },
      ] });
    const disabled = await store.config.update({
      provider: config.provider, region: config.region, ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      accessKeyIdRef: config.accessKeyIdRef, accessKeySecretRef: config.accessKeySecretRef,
      receiptCallbackTokenRef: config.receiptCallbackTokenRef, enabled: false, expectedVersion: config.version,
    });
    expect(disabled.version).toBe(config.version + 1);
    const stale = await post("/resources/sync-preview", { version: config.version, idempotencyKey: "route:stale-after-disable" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "CONCURRENT_MODIFICATION" } });
  });

  it("discovers an unmapped cloud template with a safe snapshot before an explicit import", async () => {
    const config = await store.config.get();
    if (config.status === "unconfigured") throw new Error("resource route configuration is missing");

    const previewMappingAttempt = await post("/resources/sync-preview", {
      version: config.version,
      idempotencyKey: "route:mapping-must-use-import",
      templates: [{
        externalKey: "aliyun:template:SMS_RESOURCE_ROUTE",
        signatureExternalKey: "aliyun:sign:resource-route",
        templateKey: "notice.must-not-map-in-preview",
        purpose: "notification",
      }],
    });
    expect(previewMappingAttempt.status).toBe(400);

    const preview = await post("/resources/sync-preview", {
      version: config.version,
      idempotencyKey: "route:first-discovery",
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    const signatureCandidate = previewBody.data.candidates.find((item: { resourceType: string }) => item.resourceType === "signature");
    const templateCandidate = previewBody.data.candidates.find((item: { resourceType: string }) => item.resourceType === "template");
    expect(templateCandidate).toMatchObject({
      externalKey: "aliyun:template:SMS_RESOURCE_ROUTE",
      changeType: "new",
      snapshot: {
        kind: "template",
        externalName: "Route notification",
        externalStatus: "approved",
        templateType: "notification",
        variableNames: ["orderNo"],
      },
    });
    expect(templateCandidate).not.toHaveProperty("templateKey");
    if (templateCandidate === undefined) throw new Error("expected template discovery candidate");
    expect(JSON.stringify(previewBody)).not.toContain("private provider body");
    expect(JSON.stringify(previewBody)).not.toContain("provider-secret-must-not-leak");
    const persistedCandidate = await pool.query<{ snapshot: Readonly<Record<string, unknown>> }>(
      "select snapshot from sms_kit.resource_sync_candidate where id = $1",
      [templateCandidate.id],
    );
    expect(persistedCandidate.rows[0]?.snapshot).toMatchObject({
      kind: "template",
      externalCode: "SMS_RESOURCE_ROUTE",
      externalName: "Route notification",
      externalStatus: "approved",
      templateType: "notification",
      variableNames: ["orderNo"],
    });
    expect(JSON.stringify(persistedCandidate.rows[0]?.snapshot)).not.toContain("private provider body");
    expect(JSON.stringify(persistedCandidate.rows[0]?.snapshot)).not.toContain("provider-secret-must-not-leak");
    expect(await store.resources.listTemplates({ page: 1, pageSize: 10 })).toMatchObject({ total: 0 });
    if (signatureCandidate === undefined) throw new Error("expected signature discovery candidate");

    const committed = await post("/resources/sync-commit", {
      version: config.version,
      idempotencyKey: "route:first-signature-commit",
      syncId: previewBody.data.id,
      candidates: [{ id: signatureCandidate.id, checksum: signatureCandidate.checksum }],
    });
    expect(committed.status).toBe(200);
    const signature = (await store.resources.listSignatures({ page: 1, pageSize: 10 })).items[0];
    if (signature === undefined) throw new Error("expected imported signature");

    const implicitImport = await post("/resources/sync-commit", {
      version: config.version,
      idempotencyKey: "route:first-template-commit",
      syncId: previewBody.data.id,
      candidates: [{ id: templateCandidate.id, checksum: templateCandidate.checksum }],
    });
    expect(implicitImport.status).toBe(400);
    expect(await implicitImport.json()).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    expect(await store.resources.listTemplates({ page: 1, pageSize: 10 })).toMatchObject({ total: 0 });

    const imported = await post("/templates/import", {
      version: signature.version,
      idempotencyKey: "route:first-template-import",
      candidateId: templateCandidate.id,
      checksum: templateCandidate.checksum,
      templateKey: "notice.resource-route",
      purpose: "notification",
      signatureExternalKey: signature.externalKey,
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ data: {
      templateKey: "notice.resource-route",
      externalName: "Route notification",
      variables: [{ name: "orderNo", sensitive: false }],
    } });
    await expect(store.resources.listTemplates({ page: 1, pageSize: 10 })).resolves.toMatchObject({ total: 1 });
  });
});
