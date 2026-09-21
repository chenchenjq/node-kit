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
- OTP uses priority direct delivery and never automatic resend; normal notifications use durable jobs. Both paths commit a budget reservation and unique started Attempt before any provider call.
- Only explicit provider responses proving non-acceptance may retry. Timeouts and interrupted calls set acceptance to `unknown` and reconcile without resending.
- Provider acceptance and terminal delivery are separate state machines and separate statistics.
- System verification policy, UTC daily budget and manual circuit breaker are versioned independently from provider credentials.
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
- `src/application/policy-service.ts`: versioned verification, rate-limit, budget and circuit settings.
- `src/application/resource-sync-service.ts`: paginated preview and checksum-bound commit.
- `src/application/send-service.ts`: template lookup, validation, protection and message creation.
- `src/application/send-worker.ts`: leases and provider invocation state handling.
- `src/application/dispatch-recovery-service.ts`: converts abandoned direct/queued Attempts to acceptance unknown without resending.
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
  querySendDetails(input: {
    phoneNumber: string;
    sendDate: string;
    currentPage: number;
    pageSize: number;
    bizId?: string;
  }): Promise<AliyunQueryOutput>;
}

export type AliyunFailureClass =
  | { kind: "rejected"; retryable: false; code: string }
  | { kind: "rejected"; retryable: true; code: string }
  | { kind: "unknown"; retryable: false; code: "ACCEPTANCE_UNKNOWN" };
```

Construct an OpenAPI config from resolved AccessKey ID/Secret and configured credential-free HTTPS origin for each operation. Preserve that origin in public configuration, but normalize it to the SDK's required `host[:port]` authority at the client boundary; reject paths, query, fragments and userinfo, and retain bracketed IPv6/non-default ports. Pin SDK `@alicloud/dysmsapi20170525` to `4.6.0`; compile wrapper request/response fixtures against its exported types and intercept a real generated SDK request in tests. Treat HTTP/SDK transport errors after invocation begins as `unknown`; mark retryable only for explicit Alibaba response codes maintained in a tested allowlist that prove the request was not accepted.

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

it.each([
  [{ templateType: 0, outerTemplateType: 1 }, "notification"],
  [{ templateType: 2, outerTemplateType: 0 }, "verification"],
])("maps only consistent mainland template enums", (raw, expected) => {
  expect(mapTemplate(templateFixture(raw)).templateType).toBe(expected);
});

it.each([
  { templateType: 1, outerTemplateType: 2 },
  { templateType: 6, outerTemplateType: 3 },
  { templateType: 0, outerTemplateType: 0 },
])("rejects marketing, international and conflicting enums", (raw) => {
  expect(() => mapTemplate(templateFixture(raw))).toThrowError(/unsupported template type/);
});
```

- [ ] **Step 2: Run the resource tests and confirm pagination is incomplete**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/resources.test.ts`

Expected: FAIL because complete pagination helpers do not exist.

- [ ] **Step 3: Implement cursor-independent page loops and stable resource keys**

```ts
export function toAliyunExternalKey(sign: AliyunSignDto): string {
  const fallback = createHash("sha256")
    .update(JSON.stringify([sign.businessType, sign.signName]), "utf8")
    .digest("base64url");
  return sign.orderId
    ? `aliyun:sign:${sign.orderId}`
    : `aliyun:sign:${fallback}`;
}

for (let pageIndex = 1; ; pageIndex += 1) {
  const page = await api.querySmsSignList({ pageIndex, pageSize });
  items.push(...page.items.map(mapSignature));
  if (items.length >= page.total || page.items.length === 0) break;
}
```

Validate provider response shapes before mapping. Accept signature `businessType` only when it is exactly `验证码类型` or `通用类型`; keep same-name values distinct. For templates, accept only `(templateType, outerTemplateType)` pairs `(0, 1)` as notification and `(2, 0)` as verification. Reject `(1, 2)` marketing, `(6, 3)` international/Hong Kong/Macao/Taiwan, missing/unknown values and conflicting pairs. Sort normalized resources before hashing so checksums are deterministic. Tests import the SDK 4.6.0 response types so field renames or enum drift fail compilation.

- [ ] **Step 4: Run pagination and duplicate-name tests**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/resources.test.ts && npm run typecheck --workspace sms-kit`

Expected: PASS; all pages load, partial fetches fail closed, same-name/different-type signatures have distinct keys, and only consistent mainland notification/verification templates are importable.

- [ ] **Step 5: Commit resource discovery**

```bash
git add packages/sms-kit/src/aliyun packages/sms-kit/test/unit/aliyun/resources.test.ts
git commit -m "feat: discover aliyun sms resources safely"
```

### Task 3: Build configuration and checksum-bound resource sync services

**Files:**
- Create: `packages/sms-kit/src/application/config-service.ts`
- Create: `packages/sms-kit/src/application/policy-service.ts`
- Create: `packages/sms-kit/src/application/resource-sync-service.ts`
- Create: `packages/sms-kit/src/application/checksum.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/unit/application/config-service.test.ts`
- Test: `packages/sms-kit/test/unit/application/policy-service.test.ts`
- Test: `packages/sms-kit/test/integration/application/resource-sync.test.ts`

**Interfaces:**
- Consumes: Provider, Store, SecretResolver, Authorizer, Clock, IdGenerator, EventSink.
- Produces: `ConfigService.save()`, `ConfigService.testConnection()`, `PolicyService.get()`, `PolicyService.update()`, `ResourceSyncService.preview()`, `ResourceSyncService.commit()`.

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

it("updates policy without resetting provider authorization", async () => {
  const updated = await policyService.update(actor, {
    ...defaultPolicyInput,
    expectedVersion: 1,
    systemDailyBudget: 500,
  });
  expect(updated.version).toBe(2);
  expect((await configService.get(actor)).status).toBe("ready");
});
```

- [ ] **Step 2: Run service tests and confirm missing application layer**

Run: `npm test --workspace sms-kit -- test/unit/application/config-service.test.ts test/unit/application/policy-service.test.ts && npm run test:integration --workspace sms-kit -- resource-sync.test.ts`

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

`PolicyService` validates OTP length 4-8, OTP TTL 60-900 seconds, attempts 1-10, proof TTL 30-900 seconds, phone/IP limits, nullable positive daily budget and circuit reason consistency. It authorizes `config.read/config.write`, uses the policy's independent optimistic version, and never changes provider authorization state. `commit()` must verify authorization, expiry, candidate IDs/checksums and cloud-approved status in one transaction. Importing a template requires a validated stable key, purpose and selected local signature; existing local enablement and stable keys remain unchanged on later sync.

- [ ] **Step 4: Verify config, preview, import and audit behavior**

Run: `npm test --workspace sms-kit -- test/unit/application/config-service.test.ts test/unit/application/policy-service.test.ts && npm run test:integration --workspace sms-kit -- resource-sync.test.ts`

Expected: PASS for connection-test readiness, independent policy versioning, stable key validation, expired preview rejection, checksum conflicts and audit records.

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
- Consumes: Store, Provider, PhoneNumberProtector, MessagePayloadProtector, PolicyStore, AttemptRepository, Clock, IdGenerator, EventSink.
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

it("commits the direct dispatch marker before the OTP provider call", async () => {
  provider.deferNextSend();
  const pending = service.sendOtpNow(otpInput);
  await provider.waitUntilSendCalled();
  expect(await loadStartedAttempt()).toMatchObject({ dispatchMode: "direct", leaseToken: null });
  expect(await loadBudgetReservation()).toMatchObject({ state: "held" });
  provider.resolveNextSend({ kind: "accepted", bizId: "biz-1", requestId: "req-1" });
  await pending;
});

it("rejects real sends while the manual circuit is open", async () => {
  await openCircuit("incident");
  await expect(service.sendOtpNow(otpInput)).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
  expect(provider.calls.send).toBe(0);
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
  const messageId = this.ids.messageId();
  const phoneContext = { envelopeVersion: 1, purpose: "phone", tenantId: input.tenantId,
    recordId: messageId, fieldName: "phone_ciphertext" } as const;
  const paramsContext = { envelopeVersion: 1, purpose: "render-params", tenantId: input.tenantId,
    recordId: messageId, fieldName: "render_params_ciphertext" } as const;
  const protectedPhone = await this.phoneProtector.protect(phone, phoneContext);
  const protectedParams = await this.payloadProtector.seal(input.variables, paramsContext);
  return this.store.transaction((tx) => this.store.messages.createWithSendJob({
    ...input, id: messageId,
    ...protectedPhone,
    renderParamsCiphertext: protectedParams.ciphertext,
    renderParamsKeyId: protectedParams.keyId,
  }, tx));
}
```

`sendOtpNow()` validates template/variables and rate limits, then starts a short transaction that creates or reuses the message, calls `policy.holdBudget()`, and calls `attempts.createStarted({ dispatchMode: "direct", leaseToken: null })`. Phone hourly/daily limits count trailing events under the existing phone/purpose transaction lock rather than using epoch buckets; cooldown history is retained for the maximum allowed interval so a later policy increase remains enforceable. Only after commit may it call the provider. It completes the Attempt and message by `dispatchToken`; it never persists OTP values and never resends an existing started/unknown/terminal message. A provider unknown result returns `ACCEPTANCE_UNKNOWN`. If the provider explicitly and permanently rejects without further retry, release the reservation exactly once. Both send methods require a trusted `tenantId`; message idempotency and rate limits are scoped to it, while template lookup remains system-global.

- [ ] **Step 4: Verify send orchestration and absence of plaintext**

Run: `npm test --workspace sms-kit -- test/unit/application/send-service.test.ts && npm run test:integration --workspace sms-kit -- enqueue-send.test.ts`

Expected: PASS; database searches for fixture phone and variable plaintext return no matches; direct sends commit their marker before provider invocation, retries reuse one budget reservation, circuit-open sends never reach the provider, duplicate idempotency keys create one message/job per tenant, and the same key in two tenants creates two isolated messages.

- [ ] **Step 5: Commit sending orchestration**

```bash
git add packages/sms-kit/src/application packages/sms-kit/test/unit/application packages/sms-kit/test/integration/application
git commit -m "feat: orchestrate immediate and queued sms sends"
```

### Task 5: Fence queued dispatch and recover abandoned attempts without resend

**Files:**
- Create: `packages/sms-kit/src/application/send-worker.ts`
- Create: `packages/sms-kit/src/application/dispatch-recovery-service.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/integration/application/send-worker.test.ts`
- Test: `packages/sms-kit/test/integration/application/dispatch-recovery.test.ts`

**Interfaces:**
- Consumes: `SmsProvider.send`, JobRepository leases, MessageRepository state updates, payload/phone protectors.
- Produces: `SendWorker.runBatch({ workerId, limit, leaseMs, providerTimeoutMs })`, `DispatchRecoveryService.runBatch({ limit, abandonedBefore })`.

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

it("does not resend after provider acceptance is followed by a persistence crash", async () => {
  provider.queueResult({ kind: "accepted", bizId: "biz-1", requestId: "req-1" });
  faults.failNextAttemptCompletion();
  await expect(worker.runBatch(runOptions)).rejects.toThrow(/injected persistence crash/);
  clock.advanceBy(31_000);
  await recovery.runBatch({ limit: 10, abandonedBefore: clock.now() });
  await worker.runBatch({ ...runOptions, workerId: "w2" });
  expect(provider.calls.send).toBe(1);
  expect((await loadMessage()).acceptanceStatus).toBe("unknown");
});

it("lets a late original response finalize only its dispatch token", async () => {
  provider.deferNextSend();
  const original = worker.runBatch({ ...runOptions, workerId: "w1" });
  await provider.waitUntilSendCalled();
  clock.advanceBy(31_000);
  await recovery.runBatch({ limit: 10, abandonedBefore: clock.now() });
  await worker.runBatch({ ...runOptions, workerId: "w2" });
  provider.resolveNextSend({ kind: "accepted", bizId: "biz-1", requestId: "req-1" });
  await original;
  expect(provider.calls.send).toBe(1);
  expect((await loadMessage()).acceptanceStatus).toBe("accepted");
});

it("does not send after a crash immediately following the dispatch marker", async () => {
  faults.failAfterDispatchMarker();
  await expect(worker.runBatch(runOptions)).rejects.toThrow(/injected dispatch crash/);
  clock.advanceBy(31_000);
  await recovery.runBatch({ limit: 10, abandonedBefore: clock.now() });
  await worker.runBatch({ ...runOptions, workerId: "w2" });
  expect(provider.calls.send).toBe(0);
  expect((await loadMessage()).acceptanceStatus).toBe("unknown");
});
```

- [ ] **Step 2: Run the Worker test and confirm failure**

Run on a Docker-capable host: `npm run test:integration --workspace sms-kit -- send-worker.test.ts dispatch-recovery.test.ts`

Expected: FAIL because Worker execution and state mapping are absent.

- [ ] **Step 3: Implement fenced dispatch and monotonic completion**

```ts
const leased = await jobs.lease({ workerId, limit, leaseMs });
for (const job of leased) {
  const prepared = await store.transaction(async (tx) => {
    await jobs.assertLease(job.id, job.leaseToken, tx);
    await policy.holdBudget(job.messageId, clock.now(), tx);
    return attempts.createStarted({
      messageId: job.messageId,
      dispatchMode: "queued",
      leaseToken: job.leaseToken,
    }, tx);
  });
  const input = await openProviderInput(job);
  const result = await provider.send({ ...input, timeoutMs: providerTimeoutMs });
  await completeDispatchByToken(prepared.dispatchToken, result, job.leaseToken);
}
```

Require `providerTimeoutMs < leaseMs`. Commit the started Attempt before calling `openProviderInput()`/the provider; never hold a database transaction across decryption plus network I/O. `completeDispatchByToken()` may monotonically complete the same Attempt even after its job lease expires, but it cannot modify job ownership without the matching lease token. Explicit retryable non-acceptance completes that Attempt, reschedules the same job with backoff and creates a new Attempt only on the later call. Permanent explicit rejection releases the budget after retries end. Timeout/transport uncertainty completes as unknown and creates one reconcile job.

`DispatchRecoveryService` scans direct Attempts past the direct-call deadline and queued Attempts whose lease expired. It locks each Attempt; `started` becomes `unknown`, the message becomes acceptance unknown, one reconcile job is inserted, and the send job is ended if present. It never calls `provider.send`. If a queued job has no started Attempt, it can be returned to pending with all lease fields cleared. A late original result may move its same token from unknown to accepted or, only for an explicit same-call rejection, rejected. Clear render-parameter ciphertext as soon as no future provider send can occur.

- [ ] **Step 4: Verify retries, crash recovery and data clearing**

Run on a Docker-capable host: `npm run test:integration --workspace sms-kit -- send-worker.test.ts dispatch-recovery.test.ts`

Expected: PASS; explicit retryable rejections back off at most three attempts, timeouts call `send` once, crash-after-marker-before-call is conservatively lost, crash-after-acceptance and lease expiry during an outstanding call never create a second send, stale workers cannot overwrite jobs, late same-token results finalize monotonically, and terminal records clear render parameters.

- [ ] **Step 5: Commit the send Worker**

```bash
git add packages/sms-kit/src/application/send-worker.ts packages/sms-kit/src/application/dispatch-recovery-service.ts packages/sms-kit/src/application/index.ts packages/sms-kit/test/integration/application/send-worker.test.ts packages/sms-kit/test/integration/application/dispatch-recovery.test.ts
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
- Produces: `parseAliyunReceiptBatch(value)`, `ReceiptService.ingest({ token, body, deadlineAt })`.

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

it("acknowledges a valid unmatched receipt idempotently", async () => {
  const first = await service.ingest({ token: validToken, body: unmatchedBatch, deadlineAt });
  const second = await service.ingest({ token: validToken, body: unmatchedBatch, deadlineAt });
  expect(first.acknowledgement).toEqual({ code: 0, msg: "成功" });
  expect(second.acknowledgement).toEqual({ code: 0, msg: "成功" });
  expect(await countUnmatchedReceipts()).toBe(1);
});

it("stops before the injected callback deadline", async () => {
  clock.set(new Date(deadlineAt.getTime() - 20));
  await expect(service.ingest({ token: validToken, body: validBatch, deadlineAt }))
    .rejects.toMatchObject({ code: "STORAGE_FAILURE", retryable: true });
  expect(await countReceipts()).toBe(0);
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

Validate raw byte size before JSON parsing. Resolve the expected token reference and compare decoded fixed-length token bytes with `timingSafeEqual`. Check the injected `Clock` before parsing and before starting the transaction; when less than the configured safety margin remains, throw a retryable safe error so the HTTP adapter returns 503 before its 700ms limit. Derive a deterministic receipt dedupe key from provider, BizId, report time, outcome and code. Match the message by trusted `out_id`/BizId, never by callback phone or callback-supplied tenant data; derive tenant from the matched message. Store only a keyed phone hash/masked form if diagnostic comparison is required. Insert a matched receipt and transition the message in one transaction; terminal conflicts create an event without rollback. A structurally valid unmatched receipt is inserted once with `match_status=unmatched`, increments the redacted health metric, and still returns Alibaba's success acknowledgement. The schema mirrors Alibaba Cloud's mainland `SmsReport` HTTP batch fields exactly.

- [ ] **Step 4: Verify malformed, oversized, duplicate and terminal-conflict cases**

Run: `npm test --workspace sms-kit -- test/unit/aliyun/receipt.test.ts && npm run test:integration --workspace sms-kit -- receipt-service.test.ts`

Expected: PASS; invalid tokens and oversized bodies are rejected, duplicates are no-ops, unmatched valid receipts are acknowledged once, injected deadline exhaustion is retryable without timing-flaky wall-clock assertions, and final states never regress.

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

it("queries every delivery page with required Alibaba fields", async () => {
  api.withQueryPages([queryPage({ hasNext: true }), queryPage({ hasNext: false })]);
  await reconcile.runBatch({ limit: 10 });
  expect(api.calls.querySendDetails).toEqual([
    { phoneNumber: "13800138000", sendDate: "20260913", currentPage: 1, pageSize: 50, bizId: "biz-1" },
    { phoneNumber: "13800138000", sendDate: "20260913", currentPage: 2, pageSize: 50, bizId: "biz-1" },
  ]);
});

it("keeps acceptance and delivery rollup fields distinct", async () => {
  await maintenance.rollupDirtyDates({ limit: 10 });
  expect(await statFor(today)).toMatchObject({
    submittedCount: 4, acceptedCount: 2, acceptanceRejectedCount: 1,
    acceptanceUnknownCount: 1, deliveryWaitingCount: 1, deliveredCount: 1,
    deliveryFailedCount: 0, deliveryUnknownFinalCount: 0,
  });
});
```

- [ ] **Step 2: Run maintenance tests and confirm services are missing**

Run: `npm run test:integration --workspace sms-kit -- reconcile.test.ts maintenance.test.ts && npm test --workspace sms-kit -- health.test.ts`

Expected: FAIL because reconciliation, rollup, retention and health services are absent.

- [ ] **Step 3: Implement bounded background batches**

Reconciliation leases only waiting accepted/acceptance-unknown messages, reads the final matching accepted/unknown Attempt, and uses its persisted `dispatch_marked_at`—not queued `submitted_at`—to derive `sendDate` in `Asia/Shanghai` as `yyyyMMdd`. Alibaba eligibility is the current Shanghai calendar date plus the preceding 29 dates; missing, contradictory or future Attempt history is deferred rather than guessed. It decrypts the stored mainland number with its original protection context and calls every page with `currentPage` starting at 1 and `pageSize=50`, plus optional BizId. It records a query-sourced receipt and never resends; a no-record page does not prove rejection, and an item beyond the query window becomes delivery `unknown_final`. Rollup consumes tenant/date dirty keys using version checks and overwrites tenant-scoped absolute counts with the nine explicit acceptance/delivery fields. Retention deletes expired Challenges/candidates/buckets/reservations, clears `phone_ciphertext` and `phone_key_id` together, and preserves anonymous daily statistics. Health snapshots accept `tenantId` for operational data while adding system-level budget/circuit status; they expose unmatched receipt count without another tenant's message details.

```ts
export type SmsHealthSnapshot = {
  tenantId: TenantId;
  status: "ready" | "degraded" | "disabled" | "unconfigured";
  lastConnectionTestAt?: Date;
  lastReceiptAt?: Date;
  pendingJobs: number;
  acceptanceUnknown: number;
  finalUnknown: number;
  unmatchedReceipts: number;
  systemBudgetRemaining: number | null;
  circuitOpen: boolean;
  warnings: readonly SmsErrorCode[];
};
```

- [ ] **Step 4: Run all simulated delivery tests**

Run: `npm test --workspace sms-kit && npm run typecheck --workspace sms-kit && npm run build --workspace sms-kit`

Expected: PASS with no network access; required QuerySendDetails fields and pages are exact, late receipts correct historical statistics, explicit counters stay distinct, and retention removes all expired sensitive values and matching key IDs.

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
