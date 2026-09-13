# sms-kit Next.js Admin API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose strict public DTOs and framework-light Node.js Route Handlers for sms-kit administration, receipts and scheduled jobs, then verify the complete package in a simulated Next.js-style host.

**Architecture:** Zod schemas are the single source for runtime validation and exported TypeScript DTOs. Handler factories use standard Web `Request`/`Response`, inject actor and scheduler verification, call application services, and return stable envelopes; this keeps the adapter compatible with Next.js App Router without importing UI code or binding to a deployment vendor.

**Tech Stack:** TypeScript 7.0.2, Node.js 20+, Zod 4.6.4, Vitest 5.0.0, PostgreSQL 17, standard Web Request/Response APIs; compatibility fixture uses Next.js 16.3.5, React 19.3.0 and React DOM 19.3.0.

**Spec:** `doc/prd/001-sms-kit.md` section 11.1; UI consumer rules: `doc/前端开发规范.md`; agent prompt: `doc/prompts/sms-kit-admin-ui.md`

## Global Constraints

- Complete Foundation, Aliyun Delivery and Auth Security plans first.
- Export browser-safe API DTOs from `sms-kit/next/types`; frontend and mock services use `import type` instead of duplicating them.
- Route handlers run only in Next.js Node.js Runtime, never Edge Runtime.
- Sensitive subpaths must fail a real Client Component build, while `sms-kit/next/types` type-only imports and ordinary Node.js consumers remain valid.
- Successful responses are `{ data, requestId }`; pages place `{ items, page, pageSize, total }` inside `data`; failures use the PRD stable error envelope.
- Reject unknown request fields, invalid pagination, untrusted actor/IP values, missing versions and missing write idempotency keys.
- Admin identity and roles come from the host; every handler requests the exact PRD permission before reading or mutating data.
- `Actor.tenantId` comes only from the host's trusted resolver. Operational routes always scope by it; request bodies, query parameters and arbitrary headers cannot override it.
- Server responses never return full phone numbers, AccessKeys, Secrets, OTPs, plaintext template variables, callback tokens or raw provider payloads.
- Callback and scheduler handlers are separate from authenticated admin handlers and require their own host-provided verification.
- No React components, Tailwind CSS or shadcn/ui dependencies are added to `sms-kit`.
- Do not run `npm publish`; do not add the untracked root `AGENTS.md` to commits.

---

## File Map

- `src/next/types/common.ts`: response, page, trusted actor/tenant and error DTOs.
- `src/next/types/config.ts`: config and two-stage test schemas.
- `src/next/types/resources.ts`: sync, signature and template schemas.
- `src/next/types/verification.ts`: Better Auth mappings plus versioned Challenge, rate-limit, budget and circuit settings.
- `src/next/types/messages.ts`: unmatched receipt health, message, job and explicit acceptance/delivery statistics schemas.
- `src/next/types/index.ts`: public DTO/error exports.
- `src/next/http.ts`: JSON parsing limits, envelopes and error mapping.
- `src/next/admin-router.ts`: method/path matching and actor injection.
- `src/next/handlers/config.ts`: overview/config/test handlers.
- `src/next/handlers/resources.ts`: sync/signature/template handlers.
- `src/next/handlers/operations.ts`: verification, receipt health, reconciliation, messages, stats and jobs.
- `src/next/receipt-handler.ts`: public Alibaba callback adapter.
- `src/next/task-handler.ts`: host-verified background task adapter.
- `src/next/index.ts`: public Route Handler factories.
- `test/integration/next/*.test.ts`: handler integration tests.
- `test/e2e/sms-admin-flow.test.ts`: full simulated admin flow.
- `test/fixtures/next-host/`: minimal App Router project with passing server/type-only imports and an intentionally failing Client Component case.

---

### Task 1: Define strict public DTO schemas and stable envelopes

**Files:**
- Create: `packages/sms-kit/src/next/types/common.ts`
- Create: `packages/sms-kit/src/next/types/config.ts`
- Create: `packages/sms-kit/src/next/types/resources.ts`
- Create: `packages/sms-kit/src/next/types/verification.ts`
- Create: `packages/sms-kit/src/next/types/messages.ts`
- Create: `packages/sms-kit/src/next/types/index.ts`
- Test: `packages/sms-kit/test/unit/next/dto.test.ts`

**Interfaces:**
- Consumes: domain status and error unions.
- Produces: `ApiSuccess<T>`, `ApiFailure`, `PageDto<T>`, all PRD section 11.1 DTOs and their Zod schemas.

- [ ] **Step 1: Write failing DTO strictness and redaction tests**

```ts
it("rejects unknown config fields", () => {
  expect(() => updateProviderConfigSchema.parse({
    version: 1,
    idempotencyKey: "config:1",
    region: "cn-hangzhou",
    accessKeyIdRef: "env://ALIYUN_ID",
    accessKeySecretRef: "env://ALIYUN_SECRET",
    leakedSecret: "value",
  })).toThrow();
});

it("does not expose a full phone field on MessageDto", () => {
  const dto = messageDtoSchema.parse(messageDtoFixture());
  expect(dto.phone).toEqual({ masked: "138****8000", last4Available: true });
  expect(JSON.stringify(dto)).not.toContain("+8613800138000");
});

it("keeps verification policy and provider versions independent", () => {
  const dto = verificationSettingsDtoSchema.parse(verificationFixture({
    version: 4, systemDailyBudget: null, circuitOpen: false,
  }));
  expect(dto.version).toBe(4);
  expect(dto.systemDailyBudget).toBeNull();
  expect(dto).not.toHaveProperty("providerConfigVersion");
});

it("uses explicit acceptance and delivery statistic fields", () => {
  const dto = smsStatsDtoSchema.parse(statsFixture());
  expect(dto).toMatchObject({
    submitted: 10, accepted: 7, acceptanceRejected: 2, acceptanceUnknown: 1,
    deliveryWaiting: 2, delivered: 4, deliveryFailed: 1, deliveryUnknownFinal: 0,
  });
  expect(dto).not.toHaveProperty("failed");
  expect(dto).not.toHaveProperty("unknown");
});
```

- [ ] **Step 2: Run DTO tests and confirm schemas are missing**

Run: `npm test --workspace sms-kit -- test/unit/next/dto.test.ts`

Expected: FAIL because `sms-kit/next/types` schemas do not exist.

- [ ] **Step 3: Implement strict schemas and inferred DTOs**

```ts
export const apiFailureSchema = z.object({
  error: z.object({
    code: smsErrorCodeSchema,
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    retryable: z.boolean(),
  }).strict(),
  requestId: z.string().min(1),
}).strict();

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().positive(),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
  }).strict();
}
```

Define every route DTO named in PRD section 11.1. Secret references contain only `scheme`, `maskedName`, `configured`; message phone contains only `masked`, `last4Available`; sync candidates include ID, external key, checksum and expiry. `VerificationSettingsDto` and update input include independent policy `version`, OTP/Challenge values, phone/IP limits, nullable `systemDailyBudget`, `circuitOpen` and optional redacted reason. `ReceiptHealthDto` includes `unmatchedCount`. Stats expose exactly `submitted`, `accepted`, `acceptanceRejected`, `acceptanceUnknown`, `deliveryWaiting`, `delivered`, `deliveryFailed`, `deliveryUnknownFinal` and `retry`; rates are derived server-side. Use `z.strictObject` or `.strict()` everywhere.

- [ ] **Step 4: Verify DTO fixtures and exported declaration names**

Run: `npm test --workspace sms-kit -- test/unit/next/dto.test.ts && npm run typecheck --workspace sms-kit && npm run build --workspace sms-kit`

Expected: PASS; generated declarations expose every PRD DTO from `dist/next/types/index.d.ts`.

- [ ] **Step 5: Commit DTO contracts**

```bash
git add packages/sms-kit/src/next/types packages/sms-kit/test/unit/next
git commit -m "feat: define sms admin api contracts"
```

### Task 2: Build the admin router, validation and error envelope

**Files:**
- Create: `packages/sms-kit/src/next/http.ts`
- Create: `packages/sms-kit/src/next/admin-router.ts`
- Modify: `packages/sms-kit/src/next/index.ts`
- Test: `packages/sms-kit/test/unit/next/http.test.ts`
- Test: `packages/sms-kit/test/integration/next/admin-router.test.ts`

**Interfaces:**
- Consumes: DTO schemas, `Authorizer`, `IdGenerator`, actor resolver and application services.
- Produces: `createSmsAdminHandler(options): (request: Request) => Promise<Response>`.

- [ ] **Step 1: Write failing authentication, body-limit and error-envelope tests**

```ts
it("returns the stable envelope when no actor resolves", async () => {
  const response = await handler(new Request("https://app.test/api/admin/sms/config"));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: { code: "PERMISSION_DENIED", message: "authentication required", retryable: false },
    requestId: "req-1",
  });
});

it("rejects a JSON body above the configured byte limit", async () => {
  const response = await handler(requestWithBody("x".repeat(70_000)));
  expect(response.status).toBe(413);
});

it("rejects a client-controlled tenant field", async () => {
  const response = await handler(requestAs(actorInTenantA, { tenantId: "tenant-b" }));
  expect(response.status).toBe(400);
  expect(services.calls).toHaveLength(0);
});
```

- [ ] **Step 2: Run router tests and confirm factory is missing**

Run: `npm test --workspace sms-kit -- test/unit/next/http.test.ts && npm run test:integration --workspace sms-kit -- admin-router.test.ts`

Expected: FAIL because HTTP utilities and router do not exist.

- [ ] **Step 3: Implement bounded JSON parsing and exact route matching**

```ts
export type SmsAdminHandlerOptions = {
  basePath?: string;
  maxBodyBytes?: number;
  resolveActor(request: Request): Promise<Actor | null>;
  resolveTrustedIp(request: Request): string | undefined;
  services: SmsAdminServices;
  ids: IdGenerator;
};

export function success<T>(data: T, requestId: string, status = 200): Response {
  return Response.json({ data, requestId }, { status });
}
```

Read at most `maxBodyBytes` before parsing JSON. Match method and normalized path against an explicit route table; never interpret arbitrary names as methods. Require the trusted actor resolver to return a branded `tenantId`; inject it into operational service inputs and reject client-provided tenant fields through strict schemas. Map `SmsKitError` to stable status codes and safe messages, and map unknown exceptions to `STORAGE_FAILURE`/500 without serializing causes.

- [ ] **Step 4: Verify unknown routes, malformed JSON and permission failures**

Run: `npm test --workspace sms-kit -- test/unit/next/http.test.ts && npm run test:integration --workspace sms-kit -- admin-router.test.ts`

Expected: PASS; unauthenticated is 401, unauthorized is 403, unknown routes are 404, malformed bodies are 400 and oversized bodies are 413.

- [ ] **Step 5: Commit the admin HTTP shell**

```bash
git add packages/sms-kit/src/next packages/sms-kit/test/unit/next packages/sms-kit/test/integration/next
git commit -m "feat: add sms admin route handler shell"
```

### Task 3: Implement overview, configuration and resource handlers

**Files:**
- Create: `packages/sms-kit/src/next/handlers/config.ts`
- Create: `packages/sms-kit/src/next/handlers/resources.ts`
- Modify: `packages/sms-kit/src/next/admin-router.ts`
- Test: `packages/sms-kit/test/integration/next/config-routes.test.ts`
- Test: `packages/sms-kit/test/integration/next/resource-routes.test.ts`

**Interfaces:**
- Consumes: ConfigService, ResourceSyncService, SendService test-send path, Authorizer, DTO schemas.
- Produces: handlers for `/overview`, `/config`, `/config/test-connection`, `/config/test-send`, sync preview/commit, signatures and templates.

- [ ] **Step 1: Write failing permission and checksum route tests**

```ts
it("requires sms.test for a real test send", async () => {
  const response = await requestAs(readOnlyActor, "POST", "/config/test-send", testSendBody);
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe("PERMISSION_DENIED");
});

it("returns conflict for an expired sync preview", async () => {
  const response = await requestAs(admin, "POST", "/resources/sync-commit", expiredCommitBody);
  expect(response.status).toBe(409);
  expect(await errorCode(response)).toBe("CONCURRENT_MODIFICATION");
});
```

- [ ] **Step 2: Run configuration/resource route tests and confirm routes are absent**

Run: `npm run test:integration --workspace sms-kit -- config-routes.test.ts resource-routes.test.ts`

Expected: FAIL with 404 responses for unregistered endpoints.

- [ ] **Step 3: Implement exact service mappings and redacted serializers**

```ts
routes.post("/resources/sync-commit", async ({ actor, body, requestId }) => {
  const input = resourceSyncCommitInputSchema.parse(body);
  const result = await services.resourceSync.commit(actor, input);
  return success(resourceSyncCommitResultDtoSchema.parse(result), requestId);
});
```

Configuration serializers must convert Secret references to `SecretRefDto` without resolution. Test send accepts a one-time full number but never returns it. Signature/template lists paginate at 1-100 items. Stable keys become immutable after the first send; attempted rename returns `CONCURRENT_MODIFICATION` with an actionable safe message.

- [ ] **Step 4: Verify all configuration and resource endpoints**

Run: `npm run test:integration --workspace sms-kit -- config-routes.test.ts resource-routes.test.ts`

Expected: PASS for permissions, version conflicts, strict bodies, pagination, expired previews, redaction, import and enable/disable effects.

- [ ] **Step 5: Commit configuration and resource routes**

```bash
git add packages/sms-kit/src/next packages/sms-kit/test/integration/next
git commit -m "feat: expose sms configuration and resource api"
```

### Task 4: Implement verification, message, statistics and job handlers

**Files:**
- Create: `packages/sms-kit/src/next/handlers/operations.ts`
- Modify: `packages/sms-kit/src/next/admin-router.ts`
- Test: `packages/sms-kit/test/integration/next/operations-routes.test.ts`

**Interfaces:**
- Consumes: PolicyService, Better Auth mapping settings, HealthService, ReconcileService, MessageRepository queries, StatsRepository and JobRepository.
- Produces: handlers for `/verification`, `/receipt-health`, `/reconcile`, `/messages`, `/messages/:id`, `/stats`, `/jobs/:id`.

- [ ] **Step 1: Write failing status-separation and exact-phone-query tests**

```ts
it("returns acceptance and delivery as separate fields", async () => {
  const response = await requestAs(reader, "GET", "/messages?page=1&pageSize=20");
  const body = await response.json();
  expect(body.data.items[0]).toMatchObject({
    acceptanceStatus: "accepted",
    deliveryStatus: "waiting",
  });
  expect(body.data.items[0].phone).toEqual({ masked: "138****8000", last4Available: true });
});

it("does not return another tenant's message, job or statistics", async () => {
  await seedOperations({ tenantId: tenantB });
  expect(await listMessageIds(requestAs(tenantAReader, "GET", "/messages"))).not.toContain(tenantBMessageId);
  expect((await requestAs(tenantAReader, "GET", `/jobs/${tenantBJobId}`)).status).toBe(404);
  expect(await statsFor(tenantAReader)).toEqual(tenantAOnlyStats);
});

it("updates policy with its own optimistic version", async () => {
  const response = await requestAs(admin, "PATCH", "/verification", {
    ...verificationUpdateFixture,
    version: 3,
    systemDailyBudget: 500,
    circuitOpen: true,
    circuitReason: "provider incident",
  });
  expect(response.status).toBe(200);
  expect((await response.json()).data).toMatchObject({ version: 4, circuitOpen: true });
  expect(configService.calls.save).toBe(0);
});
```

- [ ] **Step 2: Run operations route tests and confirm routes are absent**

Run: `npm run test:integration --workspace sms-kit -- operations-routes.test.ts`

Expected: FAIL with 404 responses for operations routes.

- [ ] **Step 3: Implement bounded filters and serializers**

Parse dates as ISO 8601, cap page size at 100 and cap statistics range at 366 days. `GET/PATCH /verification` reads/writes `PolicyService` using the policy version, validates all PRD ranges, and never calls `ConfigService.save`; changing policy cannot reset provider readiness. Exact phone search accepts one request value, normalizes and hashes it server-side within `actor.tenantId`, then discards it; response includes only masked phone. Reconcile returns a tenant-scoped `JobDto`, not a false completion response. Missing and other-tenant message/job IDs both return 404. Job reads require the permission associated with the originating action. Receipt health includes redacted unmatched count and system budget/circuit state.

```ts
routes.get("/stats", async ({ actor, url, requestId }) => {
  await authorizer.assert(actor, "stats.read");
  const input = statsQuerySchema.parse(Object.fromEntries(url.searchParams));
  return success(smsStatsDtoSchema.parse(await services.stats.query({ ...input, tenantId: actor.tenantId })), requestId);
});
```

- [ ] **Step 4: Verify filters, redaction, rate denominators and permissions**

Run: `npm run test:integration --workspace sms-kit -- operations-routes.test.ts`

Expected: PASS; policy/config versions remain independent, budget/circuit fields round-trip, message results never combine acceptance/delivery, exact phone input is not echoed, unmatched receipt health is present, explicit counters are returned, and rates use accepted/submitted and delivered/accepted denominators.

- [ ] **Step 5: Commit operations routes**

```bash
git add packages/sms-kit/src/next packages/sms-kit/test/integration/next/operations-routes.test.ts
git commit -m "feat: expose sms operations and statistics api"
```

### Task 5: Implement receipt and scheduled-task Route Handler factories

**Files:**
- Create: `packages/sms-kit/src/next/receipt-handler.ts`
- Create: `packages/sms-kit/src/next/task-handler.ts`
- Modify: `packages/sms-kit/src/next/index.ts`
- Test: `packages/sms-kit/test/integration/next/receipt-handler.test.ts`
- Test: `packages/sms-kit/test/integration/next/task-handler.test.ts`

**Interfaces:**
- Consumes: ReceiptService, SendWorker, DispatchRecoveryService, ReconcileService, MaintenanceService, Clock and host verification callbacks.
- Produces: `createAliyunReceiptHandler(options)` and `createSmsTaskHandler(options)`.

- [ ] **Step 1: Write failing callback acknowledgment and scheduler-auth tests**

```ts
it("acknowledges a valid callback using the Alibaba response shape", async () => {
  const response = await receiptHandler(validReceiptRequest(validPathToken));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 0, msg: "成功" });
});

it("rejects an unverified scheduler", async () => {
  const response = await taskHandler(taskRequest("send-worker", "wrong"));
  expect(response.status).toBe(401);
  expect(sendWorker.calls).toBe(0);
});

it("returns retryable 503 before the callback deadline", async () => {
  clock.setSequence([
    new Date("2026-09-13T00:00:00.000Z"),
    new Date("2026-09-13T00:00:00.690Z"),
  ]);
  const response = await receiptHandler(validReceiptRequest(validPathToken));
  expect(response.status).toBe(503);
  expect(receiptService.calls).toBe(0);
});

it("acknowledges a structurally valid unmatched receipt", async () => {
  const response = await receiptHandler(unmatchedReceiptRequest(validPathToken));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ code: 0, msg: "成功" });
});
```

- [ ] **Step 2: Run handler tests and confirm factories are missing**

Run: `npm run test:integration --workspace sms-kit -- receipt-handler.test.ts task-handler.test.ts`

Expected: FAIL because receipt/task handlers do not exist.

- [ ] **Step 3: Implement public and scheduler-specific boundaries**

```ts
export function createSmsTaskHandler(options: SmsTaskHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (!(await options.verifyScheduler(request))) return new Response(null, { status: 401 });
    const task = taskNameSchema.parse(new URL(request.url).searchParams.get("task"));
    const result = await options.tasks[task].runBatch({ limit: options.batchLimit });
    return Response.json({ data: result, requestId: options.ids.next() });
  };
}
```

Receipt handler accepts only GET connectivity checks and POST receipt bodies, validates the path token before body parsing, computes `deadlineAt = receivedAt + 700ms`, and checks the injected Clock before parsing and before delegating. Near-deadline work returns retryable 503; valid unmatched receipts return the Alibaba success acknowledgement. A separate non-gating benchmark records ordinary latency, but automated correctness never asserts a wall-clock millisecond threshold. Task handler exposes an allowlisted task union: `send-worker`, `dispatch-recovery`, `receipt-reconcile`, `data-retention`, `daily-rollup`, `resource-sync`.

- [ ] **Step 4: Verify HTTP methods, limits, time budget and task allowlist**

Run: `npm run test:integration --workspace sms-kit -- receipt-handler.test.ts task-handler.test.ts`

Expected: PASS; wrong tokens do not parse bodies, oversized batches fail, unsupported tasks never execute, unmatched receipts are acknowledged, and an injected near-deadline Clock deterministically returns 503 without a flaky real-time assertion.

- [ ] **Step 5: Commit receipt and task handlers**

```bash
git add packages/sms-kit/src/next packages/sms-kit/test/integration/next
git commit -m "feat: add sms receipt and task handlers"
```

### Task 6: Verify the complete simulated admin workflow

**Files:**
- Create: `packages/sms-kit/test/e2e/sms-admin-flow.test.ts`
- Create: `packages/sms-kit/test/fixtures/admin-host.ts`
- Modify: `packages/sms-kit/vitest.config.ts`

**Interfaces:**
- Consumes: all application services, PgSmsStore, FakeAliyunApi and Next handlers.
- Produces: one deterministic end-to-end test covering the PRD acceptance chain.

- [ ] **Step 1: Write the full failing E2E test**

```ts
it("configures, imports, sends, receives and reports one notification", async () => {
  await api.patchConfig(configInput);
  await expect(api.getOverview()).resolves.toMatchObject({ status: "untested" });
  await api.testConnection();
  const preview = await api.syncPreview();
  await api.syncCommit(selectApprovedResources(preview));
  const message = await api.enqueueFixtureNotification();
  await api.runTask("send-worker");
  await api.postReceipt(deliveredReceiptFor(message));
  await api.runTask("daily-rollup");
  expect(await api.getMessage(message.id)).toMatchObject({
    acceptanceStatus: "accepted", deliveryStatus: "delivered",
  });
  expect(await api.getStats()).toMatchObject({
    submitted: 1, accepted: 1, delivered: 1,
  });
});

it("isolates otherwise identical workflows across tenants", async () => {
  const a = await host.forTenant(tenantA).enqueueFixtureNotification(sharedIdempotencyKey);
  const b = await host.forTenant(tenantB).enqueueFixtureNotification(sharedIdempotencyKey);
  expect(a.id).not.toBe(b.id);
  await expect(host.forTenant(tenantA).getMessage(b.id)).resolves.toMatchObject({ status: 404 });
});
```

- [ ] **Step 2: Run E2E and confirm fixture gaps**

Run on a host where `docker info` succeeds: `npm test --workspace sms-kit -- test/e2e/sms-admin-flow.test.ts`

Expected: FAIL until the admin-host fixture wires the complete system.

- [ ] **Step 3: Build the deterministic host fixture**

Use PostgreSQL Testcontainers, FakeAliyunApi, fixed UTC Clock, sequential IDs, AES/HMAC test keys, two trusted tenant actors, permissions and standard Request objects. Seed only fictitious phones and approved fixture templates. Capture emitted events and assert none contain raw phones, variables, OTPs, proof tokens or Secrets. The E2E must prove that shared global templates work for both tenants while messages, jobs and statistics remain isolated.

- [ ] **Step 4: Run E2E twice and the full suite**

Run on a Docker-capable host: `npm test --workspace sms-kit -- test/e2e/sms-admin-flow.test.ts && npm test --workspace sms-kit`

Expected: PASS on both runs; shared resources work across two tenant fixtures, operational reads remain isolated, the database container is isolated per run and no live network call occurs.

- [ ] **Step 5: Commit end-to-end coverage**

```bash
git add packages/sms-kit/test/e2e packages/sms-kit/test/fixtures packages/sms-kit/vitest.config.ts
git commit -m "test: cover complete sms admin workflow"
```

### Task 7: Finalize package exports, compatibility and consumer documentation

**Files:**
- Modify: `packages/sms-kit/package.json`
- Modify: `packages/sms-kit/README.md`
- Modify: `PACKAGES.md`
- Test: `packages/sms-kit/test/compat/exports.test.ts`
- Test: `packages/sms-kit/test/compat/browser-safety.test.ts`
- Test: `packages/sms-kit/test/compat/next-build.test.ts`
- Create: `packages/sms-kit/test/fixtures/next-host/package.json`
- Create: `packages/sms-kit/test/fixtures/next-host/app/server/page.tsx`
- Create: `packages/sms-kit/test/fixtures/next-host/app/type-only/page.tsx`
- Create: `packages/sms-kit/test/fixtures/next-host/app/forbidden/page.tsx`

**Interfaces:**
- Consumes: every public module from all plans.
- Produces: final private package build, verified exports and complete host integration documentation.

- [ ] **Step 1: Write failing public-export and optional-peer tests**

```ts
it.each(["core", "application", "ports", "security", "postgres", "aliyun", "better-auth", "next/types", "testing"])(
  "imports sms-kit/%s from built output",
  async (subpath) => expect(await import(`sms-kit/${subpath}`)).toBeDefined(),
);

it("keeps core independent of optional Better Auth", async () => {
  const result = await importCoreFromFixtureWithoutBetterAuth();
  expect(result.exitCode).toBe(0);
});

it("keeps the Next runtime entry poisoned outside a React Server graph", async () => {
  await expect(import("sms-kit/next")).rejects.toThrow(/Server Component/);
});

it("builds server and type-only imports but rejects a sensitive client import", async () => {
  expect((await runNextFixture(["server", "type-only"])).exitCode).toBe(0);
  const forbidden = await runNextFixture(["forbidden"]);
  expect(forbidden.exitCode).not.toBe(0);
  expect(forbidden.output).toMatch(/server-only|Client Component/);
});
```

- [ ] **Step 2: Build and run compatibility tests to expose export gaps**

Run: `npm run build --workspace sms-kit && npm test --workspace sms-kit -- test/compat`

Expected: FAIL until every export map target, declaration and optional-peer boundary is correct.

- [ ] **Step 3: Finalize exports and README integration recipes**

Add exact dev dependencies `next@16.3.5`, `react@19.3.0` and `react-dom@19.3.0` for the compatibility fixture. Ensure the root export contains only browser-safe convenience exports. Sensitive export maps resolve the browser condition to the `server-only` poison module, while `sms-kit/next` also imports its Next-specific marker; `core`, `ports` and `next/types` remain safe. `runNextFixture()` copies the fixture to a fresh temporary directory, selects only named routes, installs or links the built package, runs `next build`, captures exit code/output and always removes the temporary directory. Passing routes import a sensitive entry only from a Server Component and use `import type` from `sms-kit/next/types` in a Client Component; the forbidden route imports `sms-kit/security` from a Client Component and must fail at build time. A separate spawned ordinary Node.js process imports `sms-kit/security` without Next.js conditions and must succeed.

README must include installation, migration bootstrap, Secret/keyring and protection-context injection, Alibaba configuration, policy/budget/circuit management, resource sync, notification send, Worker and dispatch-recovery scheduling, callback URL setup with log redaction, unmatched receipt behavior, reconciliation, retention, explicit statistics, Better Auth, high-risk proof modes, fake testing and live-test guard instructions.

Do not include a registry URL or `.npmrc`; keep `private: true`. Update `PACKAGES.md` purpose and public subpaths without claiming publication.

- [ ] **Step 4: Run the release-quality verification matrix**

Run locally:

```bash
npm ci
npm test --workspace sms-kit
npm run test:integration --workspace sms-kit
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
npm exec --workspace sms-kit -- vitest run test/compat
npm pack --dry-run --workspace sms-kit
docker run --rm -v "$PWD":/workspace -v /workspace/node_modules \
  -v /workspace/packages/sms-kit/node_modules -w /workspace node:20-alpine sh -lc \
  "npm ci && npm run test:unit --workspace sms-kit && npm run test:contract --workspace sms-kit && npm run typecheck --workspace sms-kit && npm run build --workspace sms-kit && npm exec --workspace sms-kit -- vitest run test/compat"
```

Expected: host commands run where `docker info` succeeds, including PostgreSQL Testcontainers; `npm pack --dry-run` lists only intended dist/docs assets. The Node 20 container runs no integration/E2E Testcontainers and therefore needs no Docker socket, but unit, contract, type, build, ordinary Node import and Next build compatibility all pass. The intentionally forbidden Client Component case is asserted as an expected inner build failure. Live test remains skipped and no publish occurs.

- [ ] **Step 5: Commit package completion**

```bash
git add packages/sms-kit/package.json packages/sms-kit/README.md packages/sms-kit/test/compat PACKAGES.md package-lock.json
git commit -m "docs: finalize sms-kit integration and exports"
```

---

## Final Completion Gate

Verify every PRD acceptance item against an automated test or README section, then run:

```bash
npm ci
npm test --workspace sms-kit
npm run test:integration --workspace sms-kit
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
npm exec --workspace sms-kit -- vitest run test/compat
npm pack --dry-run --workspace sms-kit
git status --short
```

Then run the Node 20 no-Docker command from Task 7 Step 4. Expected: Docker-capable host integration/E2E, compatibility fixtures, package checks and the no-Docker Node 20 lane all pass; package stays private, no live SMS is sent, and only pre-existing user-owned files may remain untracked.
