import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreateMessageInput } from "../../../src/ports/store.js";
import type { TenantId } from "../../../src/core/types.js";
import { SmsKitError } from "../../../src/core/errors.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "./helpers.js";

const tenantA = "tenant-a" as TenantId;
const tenantB = "tenant-b" as TenantId;

describe("PostgreSQL messages, attempts, receipts and jobs", () => {
  let store: PgSmsStore;
  let stop: () => Promise<void>;
  let templateId: string;

  function messageFixture(overrides: Partial<CreateMessageInput> = {}): CreateMessageInput {
    const id = randomUUID();
    return {
      id: id as CreateMessageInput["id"], tenantId: tenantA, idempotencyKey: `key:${id}`,
      templateId: templateId as CreateMessageInput["templateId"], templateKeySnapshot: "notice.shipped",
      externalTemplateCodeSnapshot: "SMS_1", signatureNameSnapshot: "Production", purpose: "shipping",
      phoneCiphertext: "enc:v1:phone", phoneKeyId: "key-1", phoneHash: "hash", phoneLast4: "1234",
      phoneMasked: "138****1234", variableNames: ["order"], renderParamsCiphertext: "enc:v1:params",
      renderParamsKeyId: "key-1", submittedAt: new Date("2026-09-13T00:00:00.000Z"),
      sendJob: { id: randomUUID(), dedupeKey: `send:${id}`, availableAt: new Date("2026-09-13T00:00:00.000Z"), maxAttempts: 3 },
      ...overrides,
    };
  }

  async function createMessage(input: CreateMessageInput) {
    return store.transaction((tx) => store.messages.createWithSendJob(input, tx));
  }

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    await migrateSmsKit(postgres.pool);
    store = new PgSmsStore(postgres.pool);
    const signatureId = randomUUID();
    templateId = randomUUID();
    await postgres.pool.query(
      `insert into sms_kit.signature (id, external_key, external_name, external_status, external_type, imported_at, last_synced_at, created_at, updated_at)
       values ($1, 'sign:production', 'Production', 'approved', 'text', now(), now(), now(), now())`,
      [signatureId],
    );
    await postgres.pool.query(
      `insert into sms_kit.template (id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, content_snapshot, variable_schema, imported_at, last_synced_at, created_at, updated_at)
       values ($2, $1, 'notice.shipped', 'SMS_1', 'Shipping', 'approved', 'notification', 'shipping', '', '["order"]', now(), now(), now(), now())`,
      [signatureId, templateId],
    );
  }, 120_000);

  afterAll(async () => stop());

  it("creates one message and job for concurrent idempotent requests", async () => {
    const input = messageFixture({ idempotencyKey: "order:A-100:shipped" });
    const [first, second] = await Promise.all([createMessage(input), createMessage(input)]);

    expect(first.message.id).toBe(second.message.id);
    expect(first.created || second.created).toBe(true);
    expect((await store.jobs.lease({ tenantId: tenantA, owner: "worker", leaseMs: 60_000, limit: 10, now: new Date("2026-09-13T00:00:01.000Z") })).length).toBe(1);
  });

  it("allows the same idempotency key in different tenants and keeps reads isolated", async () => {
    const key = "order:A-100:shipped:two-tenants";
    const [a, b] = await Promise.all([
      createMessage(messageFixture({ tenantId: tenantA, idempotencyKey: key })),
      createMessage(messageFixture({ tenantId: tenantB, idempotencyKey: key })),
    ]);
    expect(a.message.id).not.toBe(b.message.id);
    expect(await store.messages.get({ tenantId: tenantB, id: a.message.id })).toBeUndefined();
  });

  it("fences stale lease owners and permits one started attempt per message", async () => {
    const created = await createMessage(messageFixture());
    const [job] = await store.jobs.lease({ tenantId: tenantA, owner: "worker-a", leaseMs: 60_000, limit: 1, now: new Date("2026-09-13T00:00:01.000Z") });
    await store.jobs.reschedule({ tenantId: tenantA, id: job!.id, leaseToken: job!.leaseToken!, availableAt: new Date("2026-09-13T00:00:02.000Z") });
    const leasedAgain = await store.jobs.lease({ tenantId: tenantA, owner: "worker-b", leaseMs: 60_000, limit: 1, now: new Date("2026-09-13T00:00:02.000Z") });
    expect(leasedAgain[0]!.leaseToken).not.toBe(job!.leaseToken);
    await expect(store.jobs.succeed({ tenantId: tenantA, id: job!.id, leaseToken: job!.leaseToken! }))
      .rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);

    const current = leasedAgain[0]!;
    const first = await store.attempts.createStarted({
      tenantId: tenantA, messageId: created.message.id, dispatchMode: "queued", leaseToken: current.leaseToken!,
      dispatchMarkedAt: new Date("2026-09-13T00:00:03.000Z"),
    });
    await expect(store.attempts.createStarted({
      tenantId: tenantA, messageId: created.message.id, dispatchMode: "queued", leaseToken: current.leaseToken!,
      dispatchMarkedAt: new Date("2026-09-13T00:00:04.000Z"),
    })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" } satisfies Partial<SmsKitError>);
    expect(first.dispatchToken).toBeTruthy();
  });
});
