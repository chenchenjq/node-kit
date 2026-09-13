import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MessageId, TenantId } from "../../../src/core/types.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "./helpers.js";

describe("PostgreSQL policy budgets", () => {
  let store: PgSmsStore;
  let stop: (() => Promise<void>) | undefined;
  let pool: Awaited<ReturnType<typeof startPostgres>>["pool"];
  let templateId: string;
  const tenant = "tenant-a" as TenantId;

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    pool = postgres.pool;
    await migrateSmsKit(postgres.pool);
    store = new PgSmsStore(postgres.pool);
    const signatureId = randomUUID();
    templateId = randomUUID();
    await pool.query(
      `insert into sms_kit.signature (id, external_key, external_name, external_status, external_type, imported_at, last_synced_at, created_at, updated_at)
       values ($1, 'sign:policy', 'Policy', 'approved', 'text', now(), now(), now(), now())`,
      [signatureId],
    );
    await pool.query(
      `insert into sms_kit.template (id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, content_snapshot, variable_schema, imported_at, last_synced_at, created_at, updated_at)
       values ($2, $1, 'notice.policy', 'SMS_POLICY', 'Policy', 'approved', 'notification', 'policy', '', '[]', now(), now(), now(), now())`,
      [signatureId, templateId],
    );
  }, 120_000);

  afterAll(async () => stop?.());

  it("never exceeds the system daily budget under concurrency and releases once", async () => {
    const defaultPolicy = await store.policy.get();
    await store.policy.update({ ...defaultPolicy, expectedVersion: defaultPolicy.version, systemDailyBudget: 1 });
    const now = new Date("2026-09-13T12:00:00.000Z");
    const messageA = randomUUID() as MessageId;
    const messageB = randomUUID() as MessageId;
    await pool.query(
      `insert into sms_kit.send_message (id, tenant_id, idempotency_key, template_id, template_key_snapshot, external_template_code_snapshot, signature_name_snapshot, purpose, variable_names, metadata, acceptance_status, delivery_status, submitted_at, created_at, updated_at)
       values ($1, $3, $5, $2, 'notice.policy', 'SMS_POLICY', 'Policy', 'policy', '[]', '{}', 'pending', 'not_applicable', now(), now(), now()),
              ($4, $3, $6, $2, 'notice.policy', 'SMS_POLICY', 'Policy', 'policy', '[]', '{}', 'pending', 'not_applicable', now(), now(), now())`,
      [messageA, templateId, tenant, messageB, `budget:${messageA}`, `budget:${messageB}`],
    );
    const results = await Promise.allSettled([
      store.transaction((tx) => store.policy.holdBudget({ tenantId: tenant, messageId: messageA, now }, tx)),
      store.transaction((tx) => store.policy.holdBudget({ tenantId: tenant, messageId: messageB, now }, tx)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const held = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ messageId: MessageId }>;
    expect(await store.transaction((tx) => store.policy.releaseBudget({ tenantId: tenant, messageId: held.value.messageId }, tx))).toBe(true);
    expect(await store.transaction((tx) => store.policy.releaseBudget({ tenantId: tenant, messageId: held.value.messageId }, tx))).toBe(false);
  });

  it("rejects budget holds while the circuit is open", async () => {
    const policy = await store.policy.get();
    await store.policy.update({ ...policy, expectedVersion: policy.version, circuitOpen: true, circuitReason: "provider outage" });

    await expect(store.transaction((tx) => store.policy.holdBudget({
      tenantId: tenant, messageId: randomUUID() as MessageId, now: new Date("2026-09-14T00:00:00.000Z"),
    }, tx))).rejects.toMatchObject({ code: "CIRCUIT_OPEN" } satisfies Partial<SmsKitError>);
  });
});
