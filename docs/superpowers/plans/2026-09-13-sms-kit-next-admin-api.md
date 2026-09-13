# sms-kit Next.js Admin API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose strict public DTOs and framework-light Node.js Route Handlers for sms-kit administration, receipts and scheduled jobs, then verify the complete package in a simulated Next.js-style host.

**Architecture:** Zod schemas are the single source for runtime validation and exported TypeScript DTOs. Handler factories use standard Web `Request`/`Response`, inject actor and scheduler verification, call application services, and return stable envelopes; this keeps the adapter compatible with Next.js App Router without importing UI code or binding to a deployment vendor.

**Tech Stack:** TypeScript 7.0.2, Node.js 20+, Zod 4.6.4, Vitest 5.0.0, PostgreSQL 17, standard Web Request/Response APIs.

**Spec:** `doc/prd/001-sms-kit.md` section 11.1; UI consumer rules: `doc/前端开发规范.md`; agent prompt: `doc/prompts/sms-kit-admin-ui.md`

## Global Constraints

- Complete Foundation, Aliyun Delivery and Auth Security plans first.
- Export API DTOs from `sms-kit/next/types`; frontend and mock services must import these types instead of duplicating them.
- Route handlers run only in Next.js Node.js Runtime, never Edge Runtime.
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
- `src/next/types/verification.ts`: Better Auth mappings and Challenge settings.
- `src/next/types/messages.ts`: receipt health, message, job and statistics schemas.
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

Define every route DTO named in PRD section 11.1. Secret references contain only `scheme`, `maskedName`, `configured`; message phone contains only `masked`, `last4Available`; sync candidates include ID, external key, checksum and expiry. Use `z.strictObject` or `.strict()` everywhere.

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
- Consumes: Challenge settings, HealthService, ReconcileService, MessageRepository queries, StatsRepository and JobRepository.
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
```

- [ ] **Step 2: Run operations route tests and confirm routes are absent**

Run: `npm run test:integration --workspace sms-kit -- operations-routes.test.ts`

Expected: FAIL with 404 responses for operations routes.

- [ ] **Step 3: Implement bounded filters and serializers**

Parse dates as ISO 8601, cap page size at 100 and cap statistics range at 366 days. Exact phone search accepts one request value, normalizes and hashes it server-side within `actor.tenantId`, then discards it; response includes only masked phone. Reconcile returns a tenant-scoped `JobDto`, not a false completion response. Missing and other-tenant message/job IDs both return 404. Job reads require the permission associated with the originating action.

```ts
routes.get("/stats", async ({ actor, url, requestId }) => {
  await authorizer.assert(actor, "stats.read");
  const input = statsQuerySchema.parse(Object.fromEntries(url.searchParams));
  return success(smsStatsDtoSchema.parse(await services.stats.query({ ...input, tenantId: actor.tenantId })), requestId);
});
```

- [ ] **Step 4: Verify filters, redaction, rate denominators and permissions**

Run: `npm run test:integration --workspace sms-kit -- operations-routes.test.ts`

Expected: PASS; message results never combine acceptance/delivery, exact phone input is not echoed, and rates use accepted/submitted and delivered/accepted denominators.

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
- Consumes: ReceiptService, SendWorker, ReconcileService, MaintenanceService and host verification callbacks.
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

Receipt handler accepts only GET connectivity checks and POST receipt bodies, validates the path token before body parsing, and completes within the host's 700ms budget by doing only bounded parsing and one short transaction. Task handler exposes an allowlisted task union: `send-worker`, `receipt-reconcile`, `data-retention`, `daily-rollup`, `resource-sync`.

- [ ] **Step 4: Verify HTTP methods, limits, time budget and task allowlist**

Run: `npm run test:integration --workspace sms-kit -- receipt-handler.test.ts task-handler.test.ts`

Expected: PASS; wrong tokens do not parse bodies, oversized batches fail, unsupported tasks never execute, and the valid callback test completes below 500ms locally.

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

Run: `npm test --workspace sms-kit -- test/e2e/sms-admin-flow.test.ts`

Expected: FAIL until the admin-host fixture wires the complete system.

- [ ] **Step 3: Build the deterministic host fixture**

Use PostgreSQL Testcontainers, FakeAliyunApi, fixed UTC Clock, sequential IDs, AES/HMAC test keys, two trusted tenant actors, permissions and standard Request objects. Seed only fictitious phones and approved fixture templates. Capture emitted events and assert none contain raw phones, variables, OTPs, proof tokens or Secrets. The E2E must prove that shared global templates work for both tenants while messages, jobs and statistics remain isolated.

- [ ] **Step 4: Run E2E twice and the full suite**

Run: `npm test --workspace sms-kit -- test/e2e/sms-admin-flow.test.ts && npm test --workspace sms-kit`

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

**Interfaces:**
- Consumes: every public module from all plans.
- Produces: final private package build, verified exports and complete host integration documentation.

- [ ] **Step 1: Write failing public-export and optional-peer tests**

```ts
it.each(["core", "application", "ports", "security", "postgres", "aliyun", "better-auth", "next", "next/types", "testing"])(
  "imports sms-kit/%s from built output",
  async (subpath) => expect(await import(`sms-kit/${subpath}`)).toBeDefined(),
);

it("keeps core independent of optional Better Auth", async () => {
  const result = await importCoreFromFixtureWithoutBetterAuth();
  expect(result.exitCode).toBe(0);
});
```

- [ ] **Step 2: Build and run compatibility tests to expose export gaps**

Run: `npm run build --workspace sms-kit && npm test --workspace sms-kit -- test/compat`

Expected: FAIL until every export map target, declaration and optional-peer boundary is correct.

- [ ] **Step 3: Finalize exports and README integration recipes**

Ensure the root export contains only safe convenience exports and every server implementation subpath runs the browser guard. README must include installation, migration, Secret/keyring injection, Alibaba configuration, resource sync, notification send, Worker scheduling, callback URL setup with log redaction, reconciliation, retention, statistics, Better Auth, high-risk proof modes, fake testing and live-test guard instructions.

Do not include a registry URL or `.npmrc`; keep `private: true`. Update `PACKAGES.md` purpose and public subpaths without claiming publication.

- [ ] **Step 4: Run the release-quality verification matrix**

Run locally:

```bash
npm ci
npm test --workspace sms-kit
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
npm pack --dry-run --workspace sms-kit
docker run --rm -v "$PWD":/workspace -v /workspace/node_modules \
  -v /workspace/packages/sms-kit/node_modules -w /workspace node:20-alpine sh -lc \
  "npm ci && npm test --workspace sms-kit && npm run typecheck --workspace sms-kit && npm run build --workspace sms-kit"
```

Expected: all commands exit 0; `npm pack --dry-run` lists only intended dist/docs assets; Node 20 container passes; live test remains skipped and no publish occurs.

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
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
npm pack --dry-run --workspace sms-kit
git status --short
```

Expected: all checks pass, package stays private, no live SMS is sent, and only pre-existing user-owned files may remain untracked.
