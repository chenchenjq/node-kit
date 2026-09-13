# sms-kit Aliyun Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Alibaba Cloud authorization tests, paginated resource sync/import, safe immediate and queued sending, delivery receipts, reconciliation, retention, statistics, and operational health on top of the foundation ports.

**Architecture:** Wrap the Alibaba Cloud SDK behind an injected low-level API so unit tests never use the network. Application services own configuration, template and state rules; the provider adapter only translates Alibaba requests/responses, while PostgreSQL jobs provide durable asynchronous execution and reconciliation.

**Tech Stack:** TypeScript 7.0.2, Node.js 20+, Alibaba Cloud Dysmsapi SDK 4.6.0, Zod 4.6.4, Vitest 5.0.0, PostgreSQL 17.

**Spec:** `doc/prd/001-sms-kit.md`, especially sections 7.1-7.5, 7.8-7.10 and 9-13; persistent model: `doc/数据库设计.md`

## Global Constraints

- Complete the Foundation plan and its completion gate first.
- Support only Alibaba Cloud mainland China SMS and one recipient per message.
- Credentials are resolved per operation and never stored, cached, logged or attached to arbitrary errors.
- Cloud list APIs must consume all pages; a partial page failure cannot mark unseen resources unavailable.
- OTP uses priority direct delivery and never automatic resend; normal notifications use durable jobs.
- Only explicit provider responses proving non-acceptance may retry. Timeouts and interrupted calls set acceptance to `unknown` and reconcile without resending.
- Provider acceptance and terminal delivery are separate state machines and separate statistics.
- Configuration, signatures and templates are system-global; messages, jobs, rate limits, health and statistics always retain the trusted `tenantId` supplied by the host.
- Callback requests use HTTPS, a high-entropy path token, bounded bodies and idempotent receipt storage; callback data is not strong source authentication.
- Real Alibaba Cloud tests are disabled unless all opt-in guards are present; never use the credentials exposed earlier in this task.
- Do not run `npm publish`; do not add the untracked root `AGENTS.md` to commits.

---

## File Map

- `src/aliyun/api.ts`: minimal SDK-facing interface and concrete wrapper.
- `src/aliyun/client.ts`: per-operation client creation from resolved credentials.
- `src/aliyun/error-map.ts`: safe classification into rejected/retryable/unknown.
- `src/aliyun/provider.ts`: `SmsProvider` implementation.
- `src/aliyun/receipt.ts`: Zod receipt parsing and acknowledgment.
- `src/aliyun/index.ts`: public provider exports.
- `src/application/config-service.ts`: save, disable and two-stage test policies.
- `src/application/resource-sync-service.ts`: paginated preview and checksum-bound commit.
- `src/application/send-service.ts`: template lookup, validation, protection and message creation.
- `src/application/send-worker.ts`: leases and provider invocation state handling.
- `src/application/receipt-service.ts`: idempotent receipt ingestion.
- `src/application/reconcile-service.ts`: delivery detail query without resend.
- `src/application/maintenance-service.ts`: retention, dirty-date rollup and health snapshot.
- `src/application/index.ts`: application service exports.
- `src/testing/fake-aliyun-api.ts`: deterministic low-level API fake.
- `test/live/aliyun.live.test.ts`: guarded real integration test.

---

### Task 1: Wrap the Alibaba Cloud SDK and test connection permissions

**Files:**
- Create: `packages/sms-kit/src/aliyun/api.ts`
- Create: `packages/sms-kit/src/aliyun/client.ts`
- Create: `packages/sms-kit/src/aliyun/error-map.ts`
- Create: `packages/sms-kit/src/aliyun/provider.ts`
- Modify: `packages/sms-kit/src/aliyun/index.ts`
- Create: `packages/sms-kit/src/testing/fake-aliyun-api.ts`
- Test: `packages/sms-kit/test/unit/aliyun/connection.test.ts`
- Test: `packages/sms-kit/test/unit/aliyun/error-map.test.ts`

**Interfaces:**
- Consumes: `SmsProvider`, `SecretResolver`, `ProviderSendResult`, `SmsKitError`.
- Produces: `AliyunApi`, `AliyunClientFactory`, `AliyunSmsProvider`, `classifyAliyunError()`.

- [ ] **Step 1: Write failing connection and redaction tests**

```ts
it("tests list permissions without sending", async () => {
  const api = new FakeAliyunApi().withSignatures([signFixture()]).withTemplates([templateFixture()]);
  const provider = createAliyunProvider({ api, secretResolver });
  await expect(provider.testConnection(authInput)).resolves.toMatchObject({
    status: "ready",
    signatureCount: 1,
    templateCount: 1,
  });
  expect(api.calls.sendSms).toBe(0);
});

it("does not include provider credentials in mapped errors", async () => {
  const error = classifyAliyunError(new Error("request failed"));
  expect(JSON.stringify(error)).not.toContain("secret-value");
});
```

- [ ] **Step 2: Run focused tests and confirm provider is missing**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/connection.test.ts test/unit/aliyun/error-map.test.ts`

Expected: FAIL with missing Aliyun adapter exports.

- [ ] **Step 3: Implement injected SDK wrapper and safe error classification**

```ts
export interface AliyunApi {
  querySmsSignList(input: { pageIndex: number; pageSize: number }): Promise<AliyunSignPage>;
  querySmsTemplateList(input: { pageIndex: number; pageSize: number }): Promise<AliyunTemplatePage>;
  sendSms(input: AliyunSendInput): Promise<AliyunSendOutput>;
  querySendDetails(input: AliyunQueryInput): Promise<AliyunQueryOutput>;
}

export type AliyunFailureClass =
  | { kind: "rejected"; retryable: false; code: string }
  | { kind: "rejected"; retryable: true; code: string }
  | { kind: "unknown"; retryable: false; code: "ACCEPTANCE_UNKNOWN" };
```

Construct an OpenAPI config from resolved AccessKey ID/Secret and configured endpoint for each operation. Treat HTTP/SDK transport errors after invocation begins as `unknown`; mark retryable only for explicit Alibaba response codes maintained in a tested allowlist that prove the request was not accepted.

- [ ] **Step 4: Verify connection tests and core isolation**

Run: `npm test --workspace sms-kit -- test/unit/aliyun && npm run typecheck --workspace sms-kit`

Expected: PASS; connection tests call only list methods; credential values do not appear in results or errors.

- [ ] **Step 5: Commit the provider client**

```bash
git add packages/sms-kit/src/aliyun packages/sms-kit/src/testing/fake-aliyun-api.ts packages/sms-kit/test/unit/aliyun
git commit -m "feat: add aliyun sms provider client"
```

### Task 2: Implement complete paginated resource discovery

**Files:**
- Modify: `packages/sms-kit/src/aliyun/provider.ts`
- Create: `packages/sms-kit/src/aliyun/resource-map.ts`
- Test: `packages/sms-kit/test/unit/aliyun/resources.test.ts`

**Interfaces:**
- Consumes: `AliyunApi`, provider resource types.
- Produces: `listAllAliyunSignatures()`, `listAllAliyunTemplates()`, `toAliyunExternalKey()`.

- [ ] **Step 1: Write failing multi-page and partial-failure tests**

```ts
it("reads every resource page", async () => {
  const api = new FakeAliyunApi().withSignaturePages([[signFixture("a")], [signFixture("b")]]);
  const result = await listAllAliyunSignatures(api, { pageSize: 1 });
  expect(result.items.map((item) => item.externalName)).toEqual(["a", "b"]);
  expect(api.calls.querySmsSignList).toBe(2);
});

it("does not return a complete snapshot after a later page fails", async () => {
  const api = new FakeAliyunApi().failSignaturePage(2);
  await expect(listAllAliyunSignatures(api, { pageSize: 50 })).rejects.toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
  });
});
```

- [ ] **Step 2: Run the resource tests and confirm pagination is incomplete**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/resources.test.ts`

Expected: FAIL because complete pagination helpers do not exist.

- [ ] **Step 3: Implement cursor-independent page loops and stable resource keys**

```ts
export function toAliyunExternalKey(sign: AliyunSignDto): string {
  return sign.orderId
    ? `aliyun:sign:${sign.orderId}`
    : `aliyun:sign:${sign.signType}:${sign.signName}`;
}

for (let pageIndex = 1; ; pageIndex += 1) {
  const page = await api.querySmsSignList({ pageIndex, pageSize });
  items.push(...page.items.map(mapSignature));
  if (items.length >= page.total || page.items.length === 0) break;
}
```

Validate provider response shapes before mapping. Keep same-name verification and general signatures distinct. Sort normalized resources before hashing so checksums are deterministic.

- [ ] **Step 4: Run pagination and duplicate-name tests**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/resources.test.ts && npm run typecheck --workspace sms-kit`

Expected: PASS; all pages load, partial fetches fail closed, and same-name/different-type signatures have distinct keys.

- [ ] **Step 5: Commit resource discovery**

```bash
git add packages/sms-kit/src/aliyun packages/sms-kit/test/unit/aliyun/resources.test.ts
git commit -m "feat: discover aliyun sms resources safely"
```

### Task 3: Build configuration and checksum-bound resource sync services

**Files:**
- Create: `packages/sms-kit/src/application/config-service.ts`
- Create: `packages/sms-kit/src/application/resource-sync-service.ts`
- Create: `packages/sms-kit/src/application/checksum.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/unit/application/config-service.test.ts`
- Test: `packages/sms-kit/test/integration/application/resource-sync.test.ts`

**Interfaces:**
- Consumes: Provider, Store, SecretResolver, Authorizer, Clock, IdGenerator, EventSink.
- Produces: `ConfigService.save()`, `ConfigService.testConnection()`, `ResourceSyncService.preview()`, `ResourceSyncService.commit()`.

- [ ] **Step 1: Write failing readiness and stale-preview tests**

```ts
it("returns configuration to untested after a credential reference changes", async () => {
  const saved = await service.save(actor, { ...readyConfig, accessKeySecretRef: "env://NEW_SECRET" });
  expect(saved.status).toBe("untested");
  expect(saved.enabled).toBe(false);
});

it("requires exact candidate checksums at commit", async () => {
  const preview = await sync.preview(actor);
  await expect(sync.commit(actor, {
    syncId: preview.id,
    candidates: [{ id: preview.candidates[0]!.id, checksum: "wrong" }],
  })).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });
});
```

- [ ] **Step 2: Run service tests and confirm missing application layer**

Run: `npm test --workspace sms-kit -- test/unit/application/config-service.test.ts && npm run test:integration --workspace sms-kit -- resource-sync.test.ts`

Expected: FAIL because configuration and sync services are absent.

- [ ] **Step 3: Implement policy services and auditable commits**

```ts
export class ResourceSyncService {
  async preview(actor: Actor): Promise<ResourceSyncPreview> {
    await this.authorizer.assert(actor, "resource.sync");
    const [signatures, templates] = await Promise.all([
      collectAllProviderPages((input) => this.provider.listSignatures(input)),
      collectAllProviderPages((input) => this.provider.listTemplates(input)),
    ]);
    return this.store.resources.createSyncPreview({
      actorId: actor.id,
      expiresAt: this.clock.nowPlus({ hours: 24 }),
      resources: [...signatures, ...templates].map(withCanonicalChecksum),
    });
  }
}
```

`commit()` must verify authorization, expiry, candidate IDs/checksums and cloud-approved status in one transaction. Importing a template requires a validated stable key, purpose and selected local signature; existing local enablement and stable keys remain unchanged on later sync.

- [ ] **Step 4: Verify config, preview, import and audit behavior**

Run: `npm test --workspace sms-kit -- test/unit/application/config-service.test.ts && npm run test:integration --workspace sms-kit -- resource-sync.test.ts`

Expected: PASS for connection-test readiness, stable key validation, expired preview rejection, checksum conflicts and audit records.

- [ ] **Step 5: Commit configuration and resource services**

```bash
git add packages/sms-kit/src/application packages/sms-kit/test/unit/application packages/sms-kit/test/integration/application
git commit -m "feat: add sms configuration and resource sync"
```

### Task 4: Implement immediate and queued send orchestration

**Files:**
- Create: `packages/sms-kit/src/application/send-service.ts`
- Create: `packages/sms-kit/src/application/send-policy.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/unit/application/send-service.test.ts`
- Test: `packages/sms-kit/test/integration/application/enqueue-send.test.ts`

**Interfaces:**
- Consumes: Store, Provider, PhoneNumberProtector, MessagePayloadProtector, Clock, IdGenerator, EventSink.
- Produces: `SendService.sendOtpNow(input)`, `SendService.enqueueNotification(input)`.

- [ ] **Step 1: Write failing variable, idempotency and ciphertext tests**

```ts
it("stores encrypted variables for a queued notification", async () => {
  const result = await service.enqueueNotification({
    tenantId: tenantA,
    templateKey: "order.shipped",
    phone: "13800138000",
    variables: { orderNo: "A-100" },
    purpose: "notification",
    idempotencyKey: "order:A-100:shipped",
  });
  const stored = await loadMessage(result.id);
  expect(stored.renderParamsCiphertext).not.toContain("A-100");
  expect(stored.renderParamsKeyId).toBe("payload-k1");
});

it("returns the original message for the same idempotency key", async () => {
  const first = await service.enqueueNotification(input);
  const second = await service.enqueueNotification(input);
  expect(second.id).toBe(first.id);
});

it("scopes idempotency to the tenant", async () => {
  const first = await service.enqueueNotification({ ...input, tenantId: tenantA });
  const second = await service.enqueueNotification({ ...input, tenantId: tenantB });
  expect(first.id).not.toBe(second.id);
});
```

- [ ] **Step 2: Run sending tests and confirm service is missing**

Run: `npm test --workspace sms-kit -- test/unit/application/send-service.test.ts && npm run test:integration --workspace sms-kit -- enqueue-send.test.ts`

Expected: FAIL because `SendService` does not exist.

- [ ] **Step 3: Implement send validation and durable enqueue**

```ts
async enqueueNotification(input: EnqueueNotificationInput): Promise<Message> {
  const template = await this.requireUsableTemplate(input.templateKey, input.purpose);
  const phone = normalizeMainlandPhone(input.phone);
  validateTemplateVariables(template.variables, input.variables);
  const protectedPhone = await this.phoneProtector.protect(phone);
  const protectedParams = await this.payloadProtector.seal(input.variables);
  return this.store.transaction((tx) => this.store.messages.createWithSendJob({
    ...input,
    ...protectedPhone,
    renderParamsCiphertext: protectedParams.ciphertext,
    renderParamsKeyId: protectedParams.keyId,
  }, tx));
}
```

`sendOtpNow()` must validate/rate-limit and call the provider directly without persisting OTP variable values. It records only variable names and outcome; a provider unknown result returns `ACCEPTANCE_UNKNOWN` without resend. Both send methods require a trusted `tenantId`; message idempotency and rate limits are scoped to it, while template lookup remains system-global.

- [ ] **Step 4: Verify send orchestration and absence of plaintext**

Run: `npm test --workspace sms-kit -- test/unit/application/send-service.test.ts && npm run test:integration --workspace sms-kit -- enqueue-send.test.ts`

Expected: PASS; database searches for fixture phone and variable plaintext return no matches; duplicate idempotency keys create one message/job per tenant, and the same key in two tenants creates two isolated messages.

- [ ] **Step 5: Commit sending orchestration**

```bash
git add packages/sms-kit/src/application packages/sms-kit/test/unit/application packages/sms-kit/test/integration/application
git commit -m "feat: orchestrate immediate and queued sms sends"
```

### Task 5: Execute queued sends with safe retry and unknown handling

**Files:**
- Create: `packages/sms-kit/src/application/send-worker.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/integration/application/send-worker.test.ts`

**Interfaces:**
- Consumes: `SmsProvider.send`, JobRepository leases, MessageRepository state updates, payload/phone protectors.
- Produces: `SendWorker.runBatch({ workerId, limit, leaseMs })`.

- [ ] **Step 1: Write failing accepted, retryable and unknown-result tests**

```ts
it("does not resend an acceptance-unknown message", async () => {
  provider.queueResult({ kind: "unknown", code: "ACCEPTANCE_UNKNOWN" });
  await worker.runBatch({ workerId: "w1", limit: 10, leaseMs: 30_000 });
  await worker.runBatch({ workerId: "w2", limit: 10, leaseMs: 30_000 });
  expect(provider.calls.send).toBe(1);
  expect((await loadMessage()).acceptanceStatus).toBe("unknown");
  expect(await countJobs("reconcile")).toBe(1);
});
```

- [ ] **Step 2: Run the Worker test and confirm failure**

Run: `npm run test:integration --workspace sms-kit -- send-worker.test.ts`

Expected: FAIL because Worker execution and state mapping are absent.

- [ ] **Step 3: Implement one-way state handling**

```ts
switch (result.kind) {
  case "accepted":
    await messages.markAccepted(message.id, result, tx);
    await jobs.succeed(job.id, tx);
    break;
  case "rejected":
    result.retryable
      ? await jobs.reschedule(job.id, backoff(job.attemptCount), tx)
      : await messages.markRejectedAndDead(message.id, job.id, result, tx);
    break;
  case "unknown":
    await messages.markAcceptanceUnknownAndScheduleReconcile(message.id, job.id, tx);
    break;
}
```

Decrypt sensitive fields only immediately before provider invocation. Clear render-parameter ciphertext as soon as the message enters a state where no provider send will occur again. Never keep a database transaction open during the network call.

- [ ] **Step 4: Verify retries, crash recovery and data clearing**

Run: `npm run test:integration --workspace sms-kit -- send-worker.test.ts`

Expected: PASS; explicit retryable rejections back off at most three attempts, timeouts call `send` once, expired leases recover, and terminal records clear render parameters.

- [ ] **Step 5: Commit the send Worker**

```bash
git add packages/sms-kit/src/application/send-worker.ts packages/sms-kit/src/application/index.ts packages/sms-kit/test/integration/application/send-worker.test.ts
git commit -m "feat: process sms jobs without duplicate retries"
```

### Task 6: Parse and ingest bounded, idempotent delivery receipts

**Files:**
- Create: `packages/sms-kit/src/aliyun/receipt.ts`
- Create: `packages/sms-kit/src/application/receipt-service.ts`
- Modify: `packages/sms-kit/src/aliyun/index.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/unit/aliyun/receipt.test.ts`
- Test: `packages/sms-kit/test/integration/application/receipt-service.test.ts`

**Interfaces:**
- Consumes: Aliyun callback shapes, ReceiptRepository, message delivery transition rules, SecretResolver.
- Produces: `parseAliyunReceiptBatch(value)`, `ReceiptService.ingest({ token, body })`.

- [ ] **Step 1: Write failing token, duplicate and out-of-order tests**

```ts
it("rejects a wrong callback token before parsing the body", async () => {
  await expect(service.ingest({ token: "wrong", body: validBatch })).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});

it("counts duplicate receipts once", async () => {
  await service.ingest({ token: validToken, body: deliveredBatch });
  await service.ingest({ token: validToken, body: deliveredBatch });
  expect(await countReceipts()).toBe(1);
  expect(await deliveredCount()).toBe(1);
});
```

- [ ] **Step 2: Run receipt tests and confirm parsers are missing**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/receipt.test.ts && npm run test:integration --workspace sms-kit -- receipt-service.test.ts`

Expected: FAIL because receipt parsing and ingestion do not exist.

- [ ] **Step 3: Implement bounded parsing and constant-time token comparison**

```ts
const receiptSchema = z.array(z.object({
  phone_number: z.string().min(1).max(32),
  biz_id: z.string().min(1).max(128),
  send_time: z.string().max(64),
  report_time: z.string().max(64),
  success: z.boolean(),
  err_code: z.string().max(128),
  err_msg: z.string().max(512),
  sms_size: z.string().regex(/^\\d+$/).max(16),
  out_id: z.string().max(128),
}).strict()).max(options.maxBatchItems);
```

Validate raw byte size before JSON parsing. Resolve the expected token reference and compare decoded fixed-length token bytes with `timingSafeEqual`. Derive a deterministic receipt dedupe key from provider, BizId, report time, outcome and code. Match the message by trusted `out_id`/BizId, never by the callback phone number or callback-supplied tenant data; derive the tenant from the matched message. Store only the callback phone's keyed lookup hash and masked form if diagnostic comparison is required. Insert receipt and transition the message in one transaction; terminal conflicts create an event without state rollback. The schema mirrors Alibaba Cloud's mainland `SmsReport` HTTP batch fields exactly.

- [ ] **Step 4: Verify malformed, oversized, duplicate and terminal-conflict cases**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/receipt.test.ts && npm run test:integration --workspace sms-kit -- receipt-service.test.ts`

Expected: PASS; invalid tokens and oversized bodies are rejected, duplicates are no-ops, and final states never regress.

- [ ] **Step 5: Commit receipt handling**

```bash
git add packages/sms-kit/src/aliyun packages/sms-kit/src/application packages/sms-kit/test/unit/aliyun packages/sms-kit/test/integration/application
git commit -m "feat: ingest aliyun delivery receipts safely"
```

### Task 7: Reconcile unknown delivery, roll up statistics, retain data and report health

**Files:**
- Create: `packages/sms-kit/src/application/reconcile-service.ts`
- Create: `packages/sms-kit/src/application/maintenance-service.ts`
- Create: `packages/sms-kit/src/application/health-service.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/integration/application/reconcile.test.ts`
- Test: `packages/sms-kit/test/integration/application/maintenance.test.ts`
- Test: `packages/sms-kit/test/unit/application/health.test.ts`

**Interfaces:**
- Consumes: Provider query, Store reconciliation/jobs/stats, Clock, EventSink.
- Produces: `ReconcileService.runBatch()`, `MaintenanceService.rollupDirtyDates()`, `MaintenanceService.applyRetention()`, `HealthService.getSnapshot()`.

- [ ] **Step 1: Write failing late-receipt, idempotent-rollup and retention tests**

```ts
it("repairs yesterday's absolute statistic after a late receipt", async () => {
  await seedAcceptedMessage({ submittedAt: yesterday });
  await maintenance.rollupDirtyDates({ limit: 10 });
  await receiptService.ingest({ token, body: deliveredYesterday });
  await maintenance.rollupDirtyDates({ limit: 10 });
  expect(await statFor(yesterday)).toMatchObject({ acceptedCount: 1, deliveredCount: 1 });
});

it("removes sensitive payloads at their approved lifecycle boundaries", async () => {
  await maintenance.applyRetention({ batchSize: 100 });
  expect(await expiredSensitiveColumnCount()).toBe(0);
});
```

- [ ] **Step 2: Run maintenance tests and confirm services are missing**

Run: `npm run test:integration --workspace sms-kit -- reconcile.test.ts maintenance.test.ts && npm test --workspace sms-kit -- health.test.ts`

Expected: FAIL because reconciliation, rollup, retention and health services are absent.

- [ ] **Step 3: Implement bounded background batches**

Reconciliation leases only waiting/acceptance-unknown messages within the provider query window, queries details, records a query-sourced receipt, and never resends. Rollup consumes tenant/date dirty keys using version checks and overwrites tenant-scoped absolute counts. Retention deletes expired Challenges/candidates/buckets, clears sensitive columns in batches, and preserves anonymous daily statistics. Health snapshots accept `tenantId` and never aggregate another tenant's message, job, receipt or budget data.

```ts
export type SmsHealthSnapshot = {
  tenantId: TenantId;
  status: "ready" | "degraded" | "disabled" | "unconfigured";
  lastConnectionTestAt?: Date;
  lastReceiptAt?: Date;
  pendingJobs: number;
  acceptanceUnknown: number;
  finalUnknown: number;
  budgetRemaining: number;
  warnings: readonly SmsErrorCode[];
};
```

- [ ] **Step 4: Run all simulated delivery tests**

Run: `npm test --workspace sms-kit && npm run typecheck --workspace sms-kit && npm run build --workspace sms-kit`

Expected: PASS with no network access; late receipts correct historical statistics and retention removes all expired sensitive values.

- [ ] **Step 5: Commit reconciliation and maintenance**

```bash
git add packages/sms-kit/src/application packages/sms-kit/test
git commit -m "feat: reconcile and maintain sms delivery data"
```

### Task 8: Add guarded real Alibaba Cloud integration tests

**Files:**
- Create: `packages/sms-kit/test/live/aliyun.live.test.ts`
- Create: `packages/sms-kit/test/live/live-test-guard.ts`
- Modify: `packages/sms-kit/package.json`
- Create: `packages/sms-kit/README.md`

**Interfaces:**
- Consumes: Aliyun Provider and Config/Resource/Send services.
- Produces: npm script `test:live`; documented environment variables and hard safety guards.

- [ ] **Step 1: Write guard tests that skip by default and reject incomplete opt-in**

```ts
it("requires every live-test safety value", () => {
  expect(() => assertLiveTestGuard({ SMS_KIT_LIVE_TEST: "1" })).toThrowError(/allowlist/);
});

describe.runIf(process.env.SMS_KIT_LIVE_TEST === "1")("Aliyun live", () => {
  it("lists resources and sends one explicitly allowed test message", async () => {
    assertLiveTestGuard(process.env);
    await runSingleLiveScenario();
  });
});
```

- [ ] **Step 2: Run normal tests and verify no live test executes**

Run: `npm test --workspace sms-kit`

Expected: PASS; live suite is skipped and FakeAliyunApi remains the only provider used.

- [ ] **Step 3: Implement exact opt-in guards and usage documentation**

Require all of: `SMS_KIT_LIVE_TEST=1`, AccessKey ID/Secret env references, `SMS_KIT_LIVE_PHONE`, `SMS_KIT_LIVE_PHONE_ALLOWLIST`, `SMS_KIT_LIVE_SIGN_NAME`, `SMS_KIT_LIVE_TEMPLATE_CODE`, and `SMS_KIT_LIVE_TEMPLATE_PARAMS`. Assert the phone is in the allowlist, allow exactly one send per process, print only masked phone/template identifiers, and use a distinct npm script excluded from `npm test`.

Document that previously exposed credentials must be revoked and are forbidden. Document read-only connection testing separately from the one-message live scenario.

- [ ] **Step 4: Verify default guard behavior without real credentials**

Run: `npm run test:live --workspace sms-kit`

Expected: PASS with the suite skipped when `SMS_KIT_LIVE_TEST` is absent. Do not set live variables during automated implementation.

- [ ] **Step 5: Commit live-test safeguards**

```bash
git add packages/sms-kit/test/live packages/sms-kit/package.json packages/sms-kit/README.md
git commit -m "test: guard aliyun live sms verification"
```

---

## Aliyun Delivery Completion Gate

Run:

```bash
npm test --workspace sms-kit
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
npm run test:live --workspace sms-kit
```

Expected: unit/integration/build checks pass; live suite reports skipped; no SMS is sent. Proceed to Auth Security only after the gate passes.
