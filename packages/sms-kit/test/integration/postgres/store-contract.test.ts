import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChallengeId, MessageId, TenantId, TemplateId } from "../../../src/core/types.js";
import { FixedTenantContext } from "../../../src/ports/runtime.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { asSmsTransaction } from "../../../src/postgres/transaction.js";
import { FakeClock, SequenceIdGenerator } from "../../../src/testing/fakes.js";
import { runSmsStoreContract, type SmsStoreContractFactory } from "../../../src/testing/store-contract.js";
import { startPostgres } from "./helpers.js";

describe("PostgreSQL SmsStore contract", () => {
  let pool: Awaited<ReturnType<typeof startPostgres>>["pool"];
  let stop: (() => Promise<void>) | undefined;
  let templateId: TemplateId;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stop = postgres.stop;
    await migrateSmsKit(pool);
  }, 120_000);

  async function resetStore(): Promise<PgSmsStore> {
    await pool.query(`truncate table
      sms_kit.provider_config, sms_kit.admin_job_authorization, sms_kit.admin_operation, sms_kit.signature, sms_kit.template,
      sms_kit.resource_sync, sms_kit.resource_sync_candidate,
      sms_kit.send_message, sms_kit.send_attempt, sms_kit.delivery_receipt, sms_kit.send_job,
      sms_kit.otp_challenge, sms_kit.rate_limit_bucket, sms_kit.audit_event,
      sms_kit.daily_stat, sms_kit.stat_dirty_date, sms_kit.policy_config,
      sms_kit.daily_send_budget, sms_kit.send_budget_reservation`);
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
    return new PgSmsStore(pool);
  }

  function contractFactory(
    name: string,
    tenantMode: NonNullable<SmsStoreContractFactory["tenantMode"]>,
    tenantId: (value: string) => TenantId,
  ): SmsStoreContractFactory {
    return {
      name,
      tenantMode,
      createStore: resetStore,
      clock: new FakeClock(new Date("2026-09-13T12:00:00.000Z")),
      ids: new SequenceIdGenerator(`${name}-contract`),
      templateId: () => templateId,
      createVerifiedProof: async ({ tenantId: resolvedTenantId, subjectId, action, proof, now }) => {
        const id = randomUUID() as ChallengeId;
        await pool.query(
          `insert into sms_kit.otp_challenge (id, tenant_id, subject_id, action, purpose, phone_hash, code_hash, proof_hash, expires_at, verified_at, proof_expires_at, delivery_acceptance_status, created_at)
           values ($1, $2, $3, $4, 'password_change', 'hash:phone', 'hash:code', $5, $6, $6, $7, 'accepted', $6)`,
          [id, resolvedTenantId, subjectId, action, proof, now, new Date(now.getTime() + 300_000)],
        );
        return id;
      },
      messageId: () => randomUUID() as MessageId,
      tenantId,
    };
  }

  afterAll(async () => stop?.());

  runSmsStoreContract(contractFactory("multiple tenants", "multiple", (value) => value as TenantId));

  const fixedTenantId = "host-default-tenant" as TenantId;
  const fixedTenantContext = new FixedTenantContext(fixedTenantId);
  runSmsStoreContract(contractFactory(
    "fixed default tenant",
    "fixed",
    (value) => fixedTenantContext.resolve({ untrustedTenantId: value }),
  ));

  it("uses the UTC submitted date when the database session is near a local midnight", async () => {
    const store = await resetStore();
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
