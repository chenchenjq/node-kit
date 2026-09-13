import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChallengeId, MessageId, TenantId, TemplateId } from "../../../src/core/types.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { asSmsTransaction } from "../../../src/postgres/transaction.js";
import { FakeClock, SequenceIdGenerator } from "../../../src/testing/fakes.js";
import { runSmsStoreContract } from "../../../src/testing/store-contract.js";
import { startPostgres } from "./helpers.js";

describe("PostgreSQL SmsStore contract", () => {
  let store: PgSmsStore;
  let pool: Awaited<ReturnType<typeof startPostgres>>["pool"];
  let stop: (() => Promise<void>) | undefined;
  let templateId: TemplateId;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
    store = new PgSmsStore(pool);
    await pool.query(
      `insert into sms_kit.provider_config (
         id, provider, region, access_key_id_ref, access_key_secret_ref, receipt_callback_token_ref,
         status, enabled, last_test_status, created_at, updated_at
       ) values (1, 'aliyun', 'cn-hangzhou', 'secret://id', 'secret://key', 'secret://callback',
         'untested', false, 'never', now(), now())`,
    );

    const signatureId = randomUUID();
    templateId = randomUUID() as TemplateId;
    await pool.query(
      `insert into sms_kit.signature (id, external_key, external_name, external_status, external_type, imported_at, last_synced_at, created_at, updated_at)
       values ($1, 'sign:contract', 'Contract', 'approved', 'text', now(), now(), now(), now())`,
      [signatureId],
    );
    await pool.query(
      `insert into sms_kit.template (id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, content_snapshot, variable_schema, imported_at, last_synced_at, created_at, updated_at)
       values ($2, $1, 'notice.contract', 'SMS_CONTRACT', 'Contract', 'approved', 'notification', 'contract', '', '[]', now(), now(), now(), now())`,
      [signatureId, templateId],
    );
  }, 120_000);

  afterAll(async () => stop?.());

  runSmsStoreContract({
    createStore: async () => store,
    clock: new FakeClock(new Date("2026-09-13T12:00:00.000Z")),
    ids: new SequenceIdGenerator("contract"),
    templateId: () => templateId,
    createVerifiedProof: async ({ tenantId, subjectId, action, proof, now }) => {
      const id = randomUUID() as ChallengeId;
      await pool.query(
        `insert into sms_kit.otp_challenge (id, tenant_id, subject_id, action, purpose, phone_hash, code_hash, proof_hash, expires_at, verified_at, proof_expires_at, created_at)
         values ($1, $2, $3, $4, 'password_change', 'hash:phone', 'hash:code', $5, $6, $6, $7, $6)`,
        [id, tenantId, subjectId, action, proof, now, new Date(now.getTime() + 300_000)],
      );
      return id;
    },
    messageId: () => randomUUID() as MessageId,
    tenantId: (value) => value as TenantId,
  });

  it("uses the UTC submitted date when the database session is near a local midnight", async () => {
    const tenant = "tenant-utc-date" as TenantId;
    const submittedAt = new Date("2026-09-13T00:30:00.000Z");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local time zone 'America/Los_Angeles'");
      const tx = asSmsTransaction(client);
      const message = await store.messages.createWithSendJob({
        id: randomUUID() as MessageId, tenantId: tenant, idempotencyKey: "utc-date-message", templateId,
        templateKeySnapshot: "notice.contract", externalTemplateCodeSnapshot: "SMS_CONTRACT", signatureNameSnapshot: "Contract",
        purpose: "contract", phoneCiphertext: "enc:test:phone", phoneKeyId: "test-key", phoneHash: "hash:test:phone",
        phoneLast4: "0000", phoneMasked: "***0000", variableNames: [], submittedAt,
      }, tx);
      await store.stats.rollupDirtyDates({ tenantId: tenant, limit: 10 }, tx);
      expect(await store.stats.query({
        tenantId: tenant, from: new Date("2026-09-13T00:00:00.000Z"), to: new Date("2026-09-14T00:00:00.000Z"),
      }, tx)).toContainEqual(expect.objectContaining({ statDate: "2026-09-13", submittedCount: 1, templateKey: message.message.templateKeySnapshot }));
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });
});
