import { randomBytes, randomUUID } from "node:crypto";
import { ConfigService } from "../../src/application/config-service.js";
import { PolicyService } from "../../src/application/policy-service.js";
import { ResourceSyncService } from "../../src/application/resource-sync-service.js";
import { ResourceAdminService } from "../../src/application/resource-admin-service.js";
import { SendService } from "../../src/application/send-service.js";
import { SendWorker } from "../../src/application/send-worker.js";
import { MaintenanceService } from "../../src/application/maintenance-service.js";
import { PgSmsStore } from "../../src/postgres/store.js";
import { migrateSmsKit } from "../../src/postgres/migrator.js";
import { AesGcmMessagePayloadProtector, AesGcmPhoneNumberProtector, HmacHasher } from "../../src/security/index.js";
import { isCloudApproved } from "../../src/core/resource-usability.js";
import type { TenantId } from "../../src/core/types.js";
import type { SmsProvider } from "../../src/ports/provider.js";
import type { SecretResolver } from "../../src/ports/security.js";
import { startPostgres } from "../integration/postgres/helpers.js";
import { assertLiveTestGuard, claimSingleLiveSend, isTestResourceName } from "./live-test-guard.js";

/** The live and simulated tests run this identical chain in a disposable PostgreSQL container. */
export async function runLiveDeliveryScenario(dependencies: Readonly<{
  environment: Readonly<Record<string, string | undefined>>; provider: SmsProvider; secretResolver: SecretResolver;
}>) {
  const configuration = assertLiveTestGuard(dependencies.environment);
  const postgres = await startPostgres();
  try {
    await migrateSmsKit(postgres.pool);
    const store = new PgSmsStore(postgres.pool);
    const clock = { now: () => new Date() };
    const ids = { next: randomUUID, messageId: () => randomUUID() as never };
    const events = { emit: () => undefined };
    const tenantId = "sms-kit-live-test" as TenantId;
    const actor = { id: "system:live-test", tenantId };
    const authorizer = { assert: () => undefined };
    const provider: SmsProvider = {
      testConnection: (input) => dependencies.provider.testConnection(input),
      listSignatures: (input) => dependencies.provider.listSignatures(input),
      listTemplates: (input) => dependencies.provider.listTemplates(input),
      queryDelivery: (input) => dependencies.provider.queryDelivery(input),
      parseReceipt: (input) => dependencies.provider.parseReceipt(input),
      send: (input) => {
        if (input.phoneNumber !== configuration.phone || input.signatureName !== configuration.signatureName || input.templateCode !== configuration.templateCode) throw new Error("live dispatch differs from its authorized recipient or resource");
        claimSingleLiveSend();
        return dependencies.provider.send(input);
      },
    };
    const common = { store, provider, clock, ids, events, authorizer };
    const configs = new ConfigService({ ...common, secretResolver: dependencies.secretResolver });
    const configInput = { provider: "aliyun" as const, region: "cn-hangzhou", accessKeyIdRef: configuration.accessKeyIdRef, accessKeySecretRef: configuration.accessKeySecretRef, receiptCallbackTokenRef: "test-only://ephemeral-callback", enabled: true };
    const saved = await configs.save(actor, { ...configInput, expectedVersion: 0 });
    await configs.save(actor, { ...configInput, expectedVersion: saved.version });
    await configs.testConnection(actor);
    const policy = await store.policy.get();
    await new PolicyService(common).update(actor, { ...policy, expectedVersion: policy.version, systemDailyBudget: 1 });

    const auth = { region: configInput.region, accessKeyId: configuration.accessKeyIdRef, accessKeySecret: configuration.accessKeySecretRef, pageSize: 100 };
    const [signatures, templates] = await Promise.all([provider.listSignatures(auth), provider.listTemplates(auth)]);
    const signature = signatures.items.find((item) => item.externalName === configuration.signatureName);
    const template = templates.items.find((item) => item.externalCode === configuration.templateCode);
    if (signature === undefined || !isTestResourceName(signature.externalName) || !isCloudApproved(signature.externalStatus) ||
        template === undefined || !isTestResourceName(template.externalName) || !isCloudApproved(template.externalStatus) || template.templateType !== "notification") throw new Error("live resources must be approved test-only notification resources");
    const sync = new ResourceSyncService(common);
    const preview = await sync.preview(actor);
    const signatureCandidate = preview.candidates.find((item) => item.resourceType === "signature" && item.externalKey === signature.externalKey);
    const templateCandidate = preview.candidates.find((item) => item.resourceType === "template" && item.externalKey === template.externalKey);
    if (signatureCandidate === undefined || templateCandidate === undefined) throw new Error("live resource preview is incomplete");
    await sync.commit(actor, { syncId: preview.id, candidates: [{ id: signatureCandidate.id, checksum: signatureCandidate.checksum }] });
    const importedSignature = (await store.resources.listSignatures({ page: 1, pageSize: 100 })).items
      .find((item) => item.externalKey === signature.externalKey);
    if (importedSignature === undefined) throw new Error("live signature import failed");
    await new ResourceAdminService(common).importTemplate(actor, {
      version: importedSignature.version,
      idempotencyKey: `live-template:${templateCandidate.id}`,
      candidateId: templateCandidate.id,
      checksum: templateCandidate.checksum,
      templateKey: "live.test",
      purpose: "notification",
      signatureExternalKey: signature.externalKey,
    });

    const key = randomBytes(32);
    const keyring = { activeKey: async () => ({ id: "ephemeral-live-test", bytes: key }), keyById: async () => key };
    const protectors = { phoneProtector: new AesGcmPhoneNumberProtector(keyring, new HmacHasher(randomBytes(32))), payloadProtector: new AesGcmMessagePayloadProtector(keyring) };
    const message = await new SendService({ ...common, ...protectors, providerTimeoutMs: 10_000 }).enqueueNotification({ tenantId, templateKey: "live.test", phone: configuration.phone, variables: configuration.templateParams, purpose: "notification", idempotencyKey: randomUUID() });
    await new SendWorker({ store, provider, ...protectors, clock }).runBatch({ workerId: "live-test", limit: 1, leaseMs: 30_000, providerTimeoutMs: 10_000 });
    const completed = await store.messages.get({ tenantId, id: message.id });
    await store.audits.append({ id: ids.next(), tenantId, actorId: actor.id, action: "sms.test", targetType: "message", targetId: message.id, result: completed?.acceptanceStatus === "accepted" ? "succeeded" : "failed", occurredAt: clock.now() });
    await new MaintenanceService({ store, clock }).rollupDirtyDates({ limit: 10 });
    const facts = await postgres.pool.query<{ attempts: string; held: string; reconcile: string; accepted: string }>(`select
      (select count(*) from sms_kit.send_attempt where message_id = $1)::text as attempts,
      (select count(*) from sms_kit.send_budget_reservation where message_id = $1 and state = 'held')::text as held,
      (select count(*) from sms_kit.send_job where message_id = $1 and job_type = 'reconcile')::text as reconcile,
      (select coalesce(sum(accepted_count),0) from sms_kit.daily_stat where tenant_id = $2)::text as accepted`, [message.id, tenantId]);
    const audits = await postgres.pool.query<{ action: string }>("select action from sms_kit.audit_event order by occurred_at");
    return { acceptanceStatus: completed?.acceptanceStatus, attemptCount: Number(facts.rows[0]!.attempts), heldCount: Number(facts.rows[0]!.held), reconcileJobs: Number(facts.rows[0]!.reconcile), acceptedCount: Number(facts.rows[0]!.accepted), auditActions: audits.rows.map(({ action }) => action) };
  } finally { await postgres.stop(); }
}
