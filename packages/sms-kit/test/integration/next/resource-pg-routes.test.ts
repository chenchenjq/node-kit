import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

vi.mock("server-only", () => ({}));

import { ResourceSyncService } from "../../../src/application/resource-sync-service.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { TenantId } from "../../../src/core/types.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { createSmsAdminHandler } from "../../../src/next/index.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const actor = {
  id: "resource-route-admin", tenantId: "tenant-resource-route" as TenantId, permissions: ["resource.sync"],
} as AuthorizationActor;
const now = new Date("2026-09-14T00:00:00.000Z");

describe("resource sync routes with PostgreSQL", () => {
  let stop: (() => Promise<void>) | undefined;
  let pool: Pool;
  let store: PgSmsStore;
  let sync: ResourceSyncService<AuthorizationActor>;
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
        listTemplates: async () => ({ items: [] }),
      } as never,
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
      services: { task3: { resourceSync: sync } },
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
      candidates: previewBody.data.candidates.map(({ id, checksum }: { id: string; checksum: string }) => ({ id, checksum })),
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
});
