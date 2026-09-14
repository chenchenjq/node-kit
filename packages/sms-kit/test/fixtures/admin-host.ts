import { Buffer } from "node:buffer";

import {
  ConfigService,
  DispatchRecoveryService,
  HealthService,
  MaintenanceService,
  PolicyService,
  ReceiptService,
  ReconcileAdminService,
  ReconcileService,
  ResourceAdminService,
  ResourceSyncService,
  SendService,
  SendWorker,
} from "../../src/application/index.js";
import { createAliyunProvider } from "../../src/aliyun/index.js";
import { SmsKitError } from "../../src/core/errors.js";
import type { MessageId, TenantId } from "../../src/core/types.js";
import {
  createAliyunReceiptHandler,
  createSmsAdminHandler,
  createSmsTaskHandler,
  type SmsAdminAuthorizer,
  type SmsScheduledTaskName,
} from "../../src/next/index.js";
import type {
  ConnectionTestResultDto,
  MessageDetailDto,
  MessageDto,
  PageDto,
  ProviderConfigDto,
  ResourceCandidateDto,
  ResourceSyncCommitResultDto,
  ResourceSyncPreviewDto,
  SignatureDto,
  SmsOverviewDto,
  SmsStatsDto,
  TemplateDto,
} from "../../src/next/types/index.js";
import { migrateSmsKit } from "../../src/postgres/migrator.js";
import { PgSmsStore } from "../../src/postgres/store.js";
import type { SmsEvent } from "../../src/ports/runtime.js";
import type { AuthorizationActor } from "../../src/ports/security.js";
import {
  AesGcmMessagePayloadProtector,
  AesGcmPhoneNumberProtector,
  EnvSecretResolver,
  HmacHasher,
} from "../../src/security/index.js";
import { FakeAliyunApi, signFixture, templateFixture } from "../../src/testing/fake-aliyun-api.js";
import { FakeClock } from "../../src/testing/fakes.js";
import { startPostgres } from "../integration/postgres/helpers.js";

export const fixtureTenantA = "tenant-fixture-a" as TenantId;
export const fixtureTenantB = "tenant-fixture-b" as TenantId;

type FixtureTenant = typeof fixtureTenantA | typeof fixtureTenantB;
type FixtureActor = AuthorizationActor & Readonly<{ permissions: readonly string[] }>;
type AdminHandler = (request: Request) => Promise<Response>;
type ObservedResponse<T> = Readonly<{ status: number; data?: T }>;
type TaskResult = Readonly<{ status: number; data?: number }>;
type ReceiptResult = Readonly<{ status: number; data?: Readonly<{ code: number; msg: string }> }>;

const fixtureNow = new Date("2026-09-14T00:00:00.000Z");
const fixtureTemplateKey = "notice.fixture";
const fixturePurpose = "notification";
const fixtureSignatureExternalKey = "aliyun:sign:fixture-signature";
const fixtureTemplateExternalKey = "aliyun:template:SMS_FIXTURE_NOTIFICATION";
const fixturePhones: Readonly<Record<FixtureTenant, string>> = {
  [fixtureTenantA]: "13800138000",
  [fixtureTenantB]: "13900139000",
};
const fixtureVariables: Readonly<Record<FixtureTenant, Readonly<Record<string, string>>>> = {
  [fixtureTenantA]: {
    orderNo: "fixture-order-a-0001",
    otp: "fixture-otp-a-852741",
    proof: "fixture-proof-a-6vY9rB8mT2qK",
  },
  [fixtureTenantB]: {
    orderNo: "fixture-order-b-0001",
    otp: "fixture-otp-b-963852",
    proof: "fixture-proof-b-Q5fN7cR3xL1p",
  },
};
const fixtureReferences = Object.freeze({
  accessKeyId: "env://SMS_KIT_FIXTURE_ACCESS_KEY_ID",
  accessKeySecret: "env://SMS_KIT_FIXTURE_ACCESS_KEY_SECRET",
  callbackToken: "env://SMS_KIT_FIXTURE_CALLBACK_TOKEN",
});

function deterministicIds() {
  let sequence = 0;
  const next = () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
  };
  return { next, messageId: () => next() as MessageId };
}

function dataFrom<T>(value: unknown): T | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "data")) return undefined;
  return (value as Readonly<{ data: T }>).data;
}

function responseOutput(response: Response, body: unknown): Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  return { status: response.status, headers, body };
}

function requiredData<T>(response: ObservedResponse<T>): T {
  if (response.status < 200 || response.status >= 300 || response.data === undefined) {
    throw new Error(`fixture admin request failed with HTTP ${response.status}`);
  }
  return response.data;
}

function fixtureActors(): readonly FixtureActor[] {
  const permissions = [
    "config.read",
    "config.write",
    "resource.sync",
    "signature.manage",
    "template.manage",
    "sms.test",
    "message.read",
    "stats.read",
    "receipt.reconcile",
  ] as const;
  return [
    { id: "fixture-admin-a", tenantId: fixtureTenantA, permissions },
    { id: "fixture-admin-b", tenantId: fixtureTenantB, permissions },
  ];
}

function deliveredReceipt(messageId: string): string {
  return JSON.stringify([{
    phone_number: fixturePhones[fixtureTenantA],
    biz_id: "biz-1",
    out_id: messageId,
    send_time: "2026-09-14 08:00:00",
    report_time: "2026-09-14 08:00:01",
    success: true,
    err_code: "DELIVERED",
    err_msg: "fixture delivery",
    sms_size: "1",
  }]);
}

export type FixtureTenantApi = Readonly<{
  patchConfig(): Promise<ProviderConfigDto>;
  getOverview(): Promise<SmsOverviewDto>;
  testConnection(version: number): Promise<ConnectionTestResultDto>;
  enableConfig(version: number): Promise<ProviderConfigDto>;
  syncPreview(version: number): Promise<ResourceSyncPreviewDto>;
  syncCommit(version: number, syncId: string, candidates: readonly ResourceCandidateDto[]): Promise<ResourceSyncCommitResultDto>;
  listSignatures(): Promise<PageDto<SignatureDto>>;
  importTemplate(signatureVersion: number, candidate: ResourceCandidateDto): Promise<TemplateDto>;
  enableTemplate(template: TemplateDto): Promise<TemplateDto>;
  listTemplates(): Promise<PageDto<TemplateDto>>;
  enqueueFixtureNotification(idempotencyKey: string): Promise<MessageDto>;
  getMessage(id: string): Promise<ObservedResponse<MessageDetailDto>>;
  getJob(id: string): Promise<ObservedResponse<unknown>>;
  getStats(): Promise<SmsStatsDto>;
}>;

export type AdminHost = Readonly<{
  fakeAliyun: FakeAliyunApi;
  events: readonly SmsEvent[];
  forTenant(tenantId: FixtureTenant): FixtureTenantApi;
  runTask(task: SmsScheduledTaskName): Promise<TaskResult>;
  postDeliveredReceipt(messageId: string): Promise<ReceiptResult>;
  reconcileJobId(tenantId: FixtureTenant, messageId: string): Promise<string>;
  assertNoSensitiveData(): void;
  stop(): Promise<void>;
}>;

/**
 * A production-shaped, disposable host: actor resolution is bound outside
 * the request, while the application receives normal Request objects only.
 */
export async function createAdminHost(): Promise<AdminHost> {
  const postgres = await startPostgres();
  let stopPromise: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    if (stopPromise === undefined) {
      stopPromise = postgres.stop().catch((error: unknown) => {
        stopPromise = undefined;
        throw error;
      });
    }
    return stopPromise;
  };
  try {
    await migrateSmsKit(postgres.pool);
    const store = new PgSmsStore(postgres.pool);
    const clock = new FakeClock(fixtureNow);
    const ids = deterministicIds();
    const events: SmsEvent[] = [];
    const outputs: unknown[] = [];
    const receiptToken = Buffer.alloc(32, 0x51).toString("base64url");
    const schedulerToken = Buffer.alloc(32, 0x52).toString("base64url");
    const secretValues = Object.freeze({
      SMS_KIT_FIXTURE_ACCESS_KEY_ID: "fixture-access-key-id-value",
      SMS_KIT_FIXTURE_ACCESS_KEY_SECRET: "fixture-access-key-secret-value",
      SMS_KIT_FIXTURE_CALLBACK_TOKEN: receiptToken,
    });
    const secrets = new EnvSecretResolver(secretValues);
    const fakeAliyun = new FakeAliyunApi()
      .withSignatures([{ ...signFixture(), orderId: "fixture-signature", signName: "Fixture Sender" }])
      .withTemplates([{
        ...templateFixture(),
        templateCode: "SMS_FIXTURE_NOTIFICATION",
        templateName: "Fixture notification",
        templateType: 0,
        outerTemplateType: 1,
        templateContent: "Fixture order ${orderNo}; OTP ${otp}; proof ${proof}",
      }]);
    const provider = createAliyunProvider({ api: fakeAliyun, secretResolver: secrets });
    const keyring = {
      activeKey: async () => ({ id: "fixture-aes-key", bytes: Buffer.alloc(32, 0x41) }),
      keyById: async (id: string) => id === "fixture-aes-key" ? Buffer.alloc(32, 0x41) : undefined,
    };
    const phoneHasher = new HmacHasher(Buffer.alloc(32, 0x42));
    const phoneProtector = new AesGcmPhoneNumberProtector(keyring, phoneHasher);
    const payloadProtector = new AesGcmMessagePayloadProtector(keyring);
    const eventSink = { emit: (event: SmsEvent) => { events.push(event); } };
    const actors = fixtureActors();
    const actorForTenant = new Map<FixtureTenant, FixtureActor>(actors.map((actor) => [actor.tenantId as FixtureTenant, actor]));
    const authorizer: SmsAdminAuthorizer<FixtureActor> = {
      assert: (actor, action) => {
        if (!actor.permissions.includes(action)) throw new SmsKitError("PERMISSION_DENIED", "fixture actor is not authorized");
      },
      assertAny: (actor, actions) => {
        if (!actions.some((action) => actor.permissions.includes(action))) {
          throw new SmsKitError("PERMISSION_DENIED", "fixture actor is not authorized");
        }
      },
    };
    const common = { store, provider, clock, ids, events: eventSink, authorizer };
    const config = new ConfigService({ ...common, secretResolver: secrets });
    const policy = new PolicyService(common);
    const health = new HealthService({ store, clock });
    const resourceSync = new ResourceSyncService(common);
    const resources = new ResourceAdminService({ store, authorizer, clock, ids, events: eventSink });
    const testPhones = new Set(Object.values(fixturePhones).map((phone) => `+86${phone}`));
    const send = new SendService({
      store,
      provider,
      phoneProtector,
      payloadProtector,
      clock,
      ids,
      events: eventSink,
      providerTimeoutMs: 1_000,
      testRecipientAllowlist: { allows: ({ phone }) => testPhones.has(phone) },
      testAuthorizer: authorizer,
      testRequestFingerprinter: { fingerprint: (value) => phoneHasher.hash(value) },
    });
    const worker = new SendWorker({ store, provider, phoneProtector, payloadProtector, clock });
    const dispatchRecovery = new DispatchRecoveryService({ store, clock });
    const reconcile = new ReconcileService({ store, provider, phoneProtector, clock, events: eventSink, workerId: "fixture-reconcile" });
    const reconcileAdmin = new ReconcileAdminService({ store, authorizer, clock, ids });
    const maintenance = new MaintenanceService({ store, clock });
    const receiptService = new ReceiptService({ store, secrets, clock, events: eventSink });
    const receiptHandler = createAliyunReceiptHandler({
      receiptService,
      clock,
      verifyToken: (token) => token === receiptToken,
    });
    const taskHandler = createSmsTaskHandler({
      verifyScheduler: (request) => request.headers.get("x-fixture-scheduler") === schedulerToken,
      batchLimit: 100,
      ids,
      tasks: {
        "send-worker": {
          runBatch: ({ limit }) => worker.runBatch({
            workerId: "fixture-send-worker",
            limit,
            leaseMs: 60_000,
            providerTimeoutMs: 1_000,
          }),
        },
        "dispatch-recovery": {
          runBatch: ({ limit }) => dispatchRecovery.runBatch({
            limit,
            abandonedBefore: new Date(clock.now().getTime() - 60_000),
          }),
        },
        "receipt-reconcile": { runBatch: ({ limit }) => reconcile.runBatch({ limit }) },
        "data-retention": { runBatch: ({ limit }) => maintenance.applyRetention({ batchSize: limit }) },
        "daily-rollup": { runBatch: ({ limit }) => maintenance.rollupDirtyDates({ limit }) },
        // Resource synchronization is intentionally manual in this fixture;
        // the task route still receives a prebound safe no-op for its allowlist.
        "resource-sync": { runBatch: async () => 0 },
      },
    });
    const handlers = new Map<FixtureTenant, AdminHandler>(actors.map((actor) => [actor.tenantId as FixtureTenant, createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.10",
      authorizer,
      services: {
        task3: { config, health, send, resourceSync, resources },
        task4: { store, policy, health, reconcile: reconcileAdmin, phoneProtector, clock },
      },
      ids,
    })]));

    const observe = async <T>(handler: AdminHandler, request: Request): Promise<ObservedResponse<T>> => {
      const response = await handler(request);
      const body: unknown = await response.json();
      outputs.push(responseOutput(response, body));
      const data = dataFrom<T>(body);
      return { status: response.status, ...(data === undefined ? {} : { data }) };
    };
    const fixtureApi = (tenantId: FixtureTenant): FixtureTenantApi => {
      const handler = handlers.get(tenantId);
      if (handler === undefined || !actorForTenant.has(tenantId)) throw new RangeError("unknown fixture tenant");
      const request = <T>(path: string, method = "GET", body?: unknown) => observe<T>(handler, new Request(`https://sms.fixture.test/api/admin/sms${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }));
      const getConfig = async () => requiredData(await request<ProviderConfigDto>("/config"));
      return {
        patchConfig: async () => requiredData(await request<ProviderConfigDto>("/config", "PATCH", {
          version: 0,
          idempotencyKey: "fixture:config:create",
          provider: "aliyun",
          region: "cn-hangzhou",
          accessKeyIdRef: fixtureReferences.accessKeyId,
          accessKeySecretRef: fixtureReferences.accessKeySecret,
          receiptCallbackTokenRef: fixtureReferences.callbackToken,
          enabled: true,
        })),
        getOverview: async () => requiredData(await request<SmsOverviewDto>("/overview")),
        testConnection: async (version) => requiredData(await request<ConnectionTestResultDto>("/config/test-connection", "POST", {
          version,
          idempotencyKey: "fixture:config:test-connection",
        })),
        enableConfig: async (version) => requiredData(await request<ProviderConfigDto>("/config", "PATCH", {
          version,
          idempotencyKey: "fixture:config:enable",
          provider: "aliyun",
          region: "cn-hangzhou",
          accessKeyIdRef: fixtureReferences.accessKeyId,
          accessKeySecretRef: fixtureReferences.accessKeySecret,
          receiptCallbackTokenRef: fixtureReferences.callbackToken,
          enabled: true,
        })),
        syncPreview: async (version) => requiredData(await request<ResourceSyncPreviewDto>("/resources/sync-preview", "POST", {
          version,
          idempotencyKey: "fixture:resources:preview",
        })),
        syncCommit: async (version, syncId, candidates) => requiredData(await request<ResourceSyncCommitResultDto>("/resources/sync-commit", "POST", {
          version,
          idempotencyKey: "fixture:resources:commit",
          syncId,
          candidates: candidates.map(({ id, checksum }) => ({ id, checksum })),
        })),
        listSignatures: async () => requiredData(await request<PageDto<SignatureDto>>("/signatures?page=1&pageSize=20")),
        importTemplate: async (signatureVersion, candidate) => requiredData(await request<TemplateDto>("/templates/import", "POST", {
          version: signatureVersion,
          idempotencyKey: "fixture:template:import",
          candidateId: candidate.id,
          checksum: candidate.checksum,
          templateKey: fixtureTemplateKey,
          purpose: fixturePurpose,
          signatureExternalKey: fixtureSignatureExternalKey,
        })),
        enableTemplate: async (template) => requiredData(await request<TemplateDto>(`/templates/${template.id}`, "PATCH", {
          version: template.version,
          idempotencyKey: "fixture:template:enable",
          enabled: true,
        })),
        listTemplates: async () => requiredData(await request<PageDto<TemplateDto>>("/templates?page=1&pageSize=20")),
        enqueueFixtureNotification: async (idempotencyKey) => {
          const config = await getConfig();
          return requiredData(await request<MessageDto>("/config/test-send", "POST", {
            version: config.version,
            idempotencyKey,
            phone: fixturePhones[tenantId],
            templateKey: fixtureTemplateKey,
            variables: fixtureVariables[tenantId],
            purpose: fixturePurpose,
          }));
        },
        getMessage: (id) => request<MessageDetailDto>(`/messages/${encodeURIComponent(id)}`),
        getJob: (id) => request(`/jobs/${encodeURIComponent(id)}`),
        getStats: async () => requiredData(await request<SmsStatsDto>(
          `/stats?from=${encodeURIComponent("2026-09-14T00:00:00.000Z")}&to=${encodeURIComponent("2026-09-15T00:00:00.000Z")}&templateKey=${fixtureTemplateKey}&purpose=${fixturePurpose}`,
        )),
      };
    };

    return {
      fakeAliyun,
      events,
      forTenant: fixtureApi,
      runTask: async (task) => {
        const response = await taskHandler(new Request(`https://sms.fixture.test/api/tasks?task=${encodeURIComponent(task)}`, {
          method: "POST",
          headers: { "x-fixture-scheduler": schedulerToken },
        }));
        const body: unknown = await response.json();
        outputs.push(responseOutput(response, body));
        const data = dataFrom<number>(body);
        return data === undefined ? { status: response.status } : { status: response.status, data };
      },
      postDeliveredReceipt: async (messageId) => {
        const response = await receiptHandler(new Request(`https://sms.fixture.test/api/sms/receipt/${receiptToken}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: deliveredReceipt(messageId),
        }));
        const body: unknown = await response.json();
        outputs.push(responseOutput(response, body));
        const data = typeof body === "object" && body !== null && !Array.isArray(body) &&
          typeof (body as { code?: unknown }).code === "number" && typeof (body as { msg?: unknown }).msg === "string"
          ? body as Readonly<{ code: number; msg: string }>
          : undefined;
        return { status: response.status, ...(data === undefined ? {} : { data }) };
      },
      reconcileJobId: async (tenantId, messageId) => {
        const result = await postgres.pool.query<{ id: string }>(
          "select id from sms_kit.send_job where tenant_id = $1 and message_id = $2 and job_type = 'reconcile'",
          [tenantId, messageId],
        );
        const id = result.rows[0]?.id;
        if (id === undefined) throw new Error("fixture reconciliation job was not created");
        return id;
      },
      assertNoSensitiveData: () => {
        const observed = JSON.stringify({ events, outputs });
        const forbidden = [
          ...Object.values(fixturePhones),
          ...Object.values(fixtureVariables).flatMap((variables) => Object.values(variables)),
          ...Object.values(fixtureReferences),
          ...Object.values(secretValues),
          schedulerToken,
          "fixture-otp-never-issued",
          "fixture-proof-never-issued",
          "phone_ciphertext",
          "render_params_ciphertext",
          "phone_hash",
        ];
        if (forbidden.some((value) => observed.includes(value))) {
          throw new Error("fixture event or response exposed sensitive data");
        }
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
