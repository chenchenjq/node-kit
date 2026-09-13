import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MessageId, TenantId } from "../../../src/core/types.js";
import type { CreateMessageInput } from "../../../src/ports/store.js";
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

  it("never lets a foreign message or reservation consume the global budget", async () => {
    const ownTenant = "tenant-budget-owner" as TenantId;
    const foreignTenant = "tenant-budget-foreign" as TenantId;
    const now = new Date("2026-09-15T00:00:00.000Z");
    const policy = await store.policy.get();
    const { circuitReason: _ignoredCircuitReason, ...closedPolicy } = policy;
    await store.policy.update({ ...closedPolicy, expectedVersion: policy.version, circuitOpen: false, systemDailyBudget: null });
    const owner = (await store.messages.createWithSendJob({
      id: randomUUID() as MessageId, tenantId: ownTenant, idempotencyKey: `owner:${randomUUID()}`, templateId: templateId as CreateMessageInput["templateId"],
      templateKeySnapshot: "notice.policy", externalTemplateCodeSnapshot: "SMS_POLICY", signatureNameSnapshot: "Policy", purpose: "policy",
      phoneCiphertext: "enc:test", phoneKeyId: "key", phoneHash: "hash", phoneLast4: "0000", phoneMasked: "***0000", variableNames: [], submittedAt: now,
    })).message;
    await store.transaction((tx) => store.policy.holdBudget({ tenantId: ownTenant, messageId: owner.id, now }, tx));
    const before = await pool.query<{ held_count: string }>("select held_count::text from sms_kit.daily_send_budget where budget_date = $1::date", ["2026-09-15"]);

    await expect(store.transaction((tx) => store.policy.holdBudget({ tenantId: foreignTenant, messageId: owner.id, now }, tx)))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    const after = await pool.query<{ held_count: string }>("select held_count::text from sms_kit.daily_send_budget where budget_date = $1::date", ["2026-09-15"]);
    expect(after.rows[0]?.held_count).toBe(before.rows[0]?.held_count);
  });

  it("checks the circuit under lock even when an owned reservation already exists", async () => {
    const policy = await store.policy.get();
    const now = new Date("2026-09-16T00:00:00.000Z");
    const message = (await store.messages.createWithSendJob({
      id: randomUUID() as MessageId, tenantId: tenant, idempotencyKey: `circuit:${randomUUID()}`, templateId: templateId as CreateMessageInput["templateId"],
      templateKeySnapshot: "notice.policy", externalTemplateCodeSnapshot: "SMS_POLICY", signatureNameSnapshot: "Policy", purpose: "policy",
      phoneCiphertext: "enc:test", phoneKeyId: "key", phoneHash: "hash", phoneLast4: "0000", phoneMasked: "***0000", variableNames: [], submittedAt: now,
    })).message;
    await store.transaction((tx) => store.policy.holdBudget({ tenantId: tenant, messageId: message.id, now }, tx));
    await store.policy.update({ ...policy, expectedVersion: policy.version, circuitOpen: true, circuitReason: "maintenance" });

    await expect(store.transaction((tx) => store.policy.holdBudget({ tenantId: tenant, messageId: message.id, now }, tx)))
      .rejects.toMatchObject({ code: "CIRCUIT_OPEN" } satisfies Partial<SmsKitError>);
  });
});
