# sms-kit

Private Node.js SMS toolkit with an Alibaba Cloud (Aliyun) provider. The package's default `npm test --workspace sms-kit` does not contact Aliyun. Live tests use separate scripts and are skipped unless explicitly opted in.

For coding agents and other AI tools, start with [`AI_USAGE.md`](./AI_USAGE.md). It is a compact, normative integration guide derived from the current public exports.

## Install and public boundary

Install this private workspace package through your organization's normal dependency workflow. A PostgreSQL host also needs `pg`; a Better Auth host adds `better-auth` only when it enables that adapter.

```sh
npm install sms-kit pg
```

`sms-kit` is server software. Its public subpaths deliberately separate browser-safe contracts from runtime implementations:

| Subpath | Intended use |
| --- | --- |
| `sms-kit/core`, `sms-kit/ports` | Domain contracts and framework-neutral interfaces. |
| `sms-kit/next/types` | Public admin DTOs for frontend code; prefer `import type`. |
| `sms-kit/application`, `sms-kit/security`, `sms-kit/postgres`, `sms-kit/aliyun`, `sms-kit/better-auth`, `sms-kit/next` | Server-only implementations. Browser builds deliberately reject them. |
| `sms-kit/testing` | Node/Vitest test helpers, not a browser runtime entry. |

The root export contains no server implementation. Import the specific subpath that owns the capability. In a Next.js App Router host, set a sensitive Route Handler to the Node runtime and never import a sensitive subpath from a Client Component:

```ts
// app/api/admin/sms/[...path]/route.ts
export const runtime = "nodejs";

import { createSmsAdminHandler } from "sms-kit/next";

const handler = createSmsAdminHandler({
  basePath: "/api/admin/sms",
  resolveActor: resolveTrustedActor,
  resolveTrustedIp: resolveTrustedProxyIp,
  authorizer: smsAuthorizer,
  csrfProtection: {
    // Needed when request.url contains an internal reverse-proxy origin.
    allowedOrigins: ["https://admin.example.com"],
    // Bind this check to the same session that resolveTrustedActor reads.
    verifyToken: verifyHostCsrfToken,
  },
  services: smsAdminServices,
  ids,
});

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
```

`resolveActor` and `resolveTrustedIp` are host security boundaries. Derive the tenant, actor, roles, and proxy IP there; never accept any of them from an admin request body, query string, or arbitrary header. Admin responses use `{ data, requestId }`, and the public DTO types are available without importing the server runtime:

```ts
import type { ApiSuccess, SmsOverviewDto } from "sms-kit/next/types";

type OverviewResponse = ApiSuccess<SmsOverviewDto>;
```

Every admin route with a body requires `Content-Type: application/json`; form,
text, and other CORS-simple bodies are rejected. Cookie-authenticated writes
also require either an exact same/public `Origin` or the host-owned
`verifyToken` check. `allowedOrigins` must contain exact origins (no paths or
wildcards), normally HTTPS; explicit `localhost`, `127.0.0.1`, and `[::1]`
HTTP origins are accepted only for development. CORS configuration alone is
not a CSRF boundary. The default fails closed whenever any cookie is present,
even alongside an `Authorization` header: an attacker-controlled header must
not disable protection for a valid browser session. A bearer/service-only host
with infrastructure cookies, or a mixed host, must supply
`isCookieAuthenticated(request, actor)` and return `false` only after its
trusted authentication boundary has positively identified that request as a
non-cookie principal. Service callers must not synthesize browser `Origin`
headers.

## PostgreSQL bootstrap

Run package migrations during a controlled deployment step before serving requests. The migrator owns its schema ledger, applies migrations transactionally, and serializes concurrent runs with an advisory lock; do not copy SQL files into an application migration manually.

```ts
import { Pool } from "pg";
import { migrateSmsKit, PgSmsStore } from "sms-kit/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrateSmsKit(pool);

const store = new PgSmsStore(pool);
```

The package build includes the migration assets required by `migrateSmsKit`. Keep the `Pool`, its lifecycle, and database credentials owned by the host.

## Secrets, encryption, and protection contexts

Provider credentials and callback tokens are stored as references, not values. `EnvSecretResolver` accepts only explicit `env://UPPERCASE_NAME` references. Supply any other resolver from the host's secret manager; do not log resolved values or attach them to error telemetry.

```ts
import {
  AesGcmMessagePayloadProtector,
  AesGcmPhoneNumberProtector,
  EnvSecretResolver,
  HmacHasher,
  type AesKeyring,
} from "sms-kit/security";

const secretResolver = new EnvSecretResolver(process.env);
const keyring: AesKeyring = hostManagedAesKeyring;
const hmacKey: Buffer = hostManagedThirtyTwoByteHmacKey;
const hasher = new HmacHasher(hmacKey);

const phoneProtector = new AesGcmPhoneNumberProtector(keyring, hasher);
const payloadProtector = new AesGcmMessagePayloadProtector(keyring);
```

The host-owned `AesKeyring` returns an active key ID and key bytes only at runtime. `HmacHasher` requires a 32-byte key. Do not reuse ciphertext across tenants, messages, or fields: a `ProtectionContext` binds envelope version, purpose, trusted tenant ID, record ID, and field name as authenticated data. `SendService` supplies those contexts for normal sends; direct uses of a protector must preserve the same binding.

## Alibaba configuration and administration

Create the provider with a resolver, never with literal AccessKeys:

```ts
import { createAliyunProvider } from "sms-kit/aliyun";

const provider = createAliyunProvider({ secretResolver });
```

Use `ConfigService` or the mounted admin API to save the region, optional endpoint, and `accessKeyIdRef`, `accessKeySecretRef`, and `receiptCallbackTokenRef`. A public endpoint is a credential-free HTTPS origin such as `https://dysmsapi.aliyuncs.com` or `https://[2001:db8::1]:8443`; userinfo, a non-root path, query, and fragment are rejected. The configured origin is preserved in storage and API responses, while the Aliyun client boundary supplies only its `host[:port]` authority to the SDK. Omit it to use the SDK default. Every write carries its optimistic `version` and idempotency key. The provider resolves references only for a call, and neither APIs nor logs should reveal their values.

The Next admin adapter exposes configuration, resource, verification, operation, and read routes under the chosen `basePath`. Give it only service instances built at the trusted server boundary. It validates strict request DTOs, requests the exact host permission, scopes operational reads to the trusted tenant, and redacts phones, secrets, OTPs, template variables, callback tokens, and raw provider payloads.

Verification policy is independent from provider configuration. Manage OTP length/TTL/attempts, phone/IP limits, `systemDailyBudget`, and the manual circuit through `PolicyService.get()` and versioned `PolicyService.patch()` (or `GET/PATCH /verification`). Phone hourly and daily limits are trailing 1-hour and 24-hour windows, serialized with the phone/purpose transaction lock; they are not epoch-aligned buckets. Cooldown events are retained for the maximum supported interval so raising that policy cannot erase recent history. A configured daily budget reserves capacity once per message; an open circuit rejects real sends. Do not treat a provider-config version as a policy version.

## Resource synchronization and notification delivery

Provider signatures and templates are system-wide resources. Use `ResourceSyncService.preview()` to fetch a short-lived candidate snapshot. The first preview includes safe discovery records for cloud templates that have never been imported (provider name/status/type and declared variable names), without inventing a local key or persisting provider content. An administrator must then explicitly select a candidate and call `/templates/import` with its checksum, stable local key, purpose, and signature. `/resources/sync-commit` applies selected signatures and refreshes only templates whose persisted local mapping still matches exactly; it rejects every `new` template candidate, including mapped candidates from an older preview. The application-level `preview({ templates: ... })` compatibility field is deprecated and rejected. A preview expires after 24 hours; do not directly persist an arbitrary provider listing or reuse an expired checksum.

For ordinary business notifications, send through `SendService`, not directly through the provider:

```ts
await sendService.enqueueNotification({
  tenantId: trustedTenantId,
  templateKey: "notice.shipped",
  phone: recipientFromTrustedBusinessRecord,
  variables: { orderNumber: "…" },
  purpose: "order.shipped",
  idempotencyKey: `order-shipped:${orderId}`,
});
```

The trusted application layer supplies `tenantId`; it must never be copied from HTTP input. The service validates template variables, encrypts the phone and render parameters, persists the message and job before dispatch, and keeps provider acceptance separate from final delivery. `enqueueTestNotification()` is a separate allowlisted, permission-checked admin path. `sendOtpNow()` is for the authentication flow.

Run the worker from an authenticated scheduler, not from a browser or request body. `SendWorker.runBatch()` leases queued notification jobs; `DispatchRecoveryService.runBatch()` marks abandoned dispatches conservatively as acceptance-unknown and never sends them again. A host adapter can bind both into `createSmsTaskHandler()` together with reconciliation, retention, rollup, and any approved resource-sync task:

```ts
import { createSmsTaskHandler } from "sms-kit/next";

const taskHandler = createSmsTaskHandler({
  verifyScheduler: verifyTrustedSchedulerRequest,
  batchLimit: 100,
  ids,
  tasks: hostBoundSmsTasks,
});
```

`hostBoundSmsTasks` must calculate service-specific inputs such as `workerId`, lease durations, and an `abandonedBefore` timestamp itself. The scheduler endpoint accepts only a predeclared task name and a bodyless POST; it cannot choose a tenant, raw job payload, or arbitrary service method.

## Receipts, reconciliation, retention, and statistics

Expose the Alibaba callback as a separate, public server route:

```ts
import { createAliyunReceiptHandler } from "sms-kit/next";

const receiptHandler = createAliyunReceiptHandler({
  receiptService,
  clock,
  verifyToken: verifyReceiptPathToken,
});
```

Use an HTTPS callback URL whose final path segment is a high-entropy opaque token. `verifyToken` should use a host-controlled constant-time comparison. The handler checks the token before reading the body, applies payload and deadline limits, and returns only generic safe failures. Redact that path segment, phone numbers, OTPs, template parameters, credentials, and raw callback/provider payloads from proxy and application logs.

The callback's 700 ms budget covers token verification, streaming body reads,
and the complete ingestor promise. On expiry the handler returns retryable 503,
cancels the body reader best-effort, and aborts a shared `AbortSignal`; custom
ingestors must pass that signal to cancellable I/O. A late resolve/rejection is
observed and cannot rewrite the response or become an unhandled rejection. The
built-in `ReceiptService` checks the signal at async boundaries, and
`PgSmsStore` rolls its transaction back when cancellation is observed before
COMMIT is dispatched. Once PostgreSQL has accepted COMMIT, the adapter waits
for its outcome before releasing the connection; the handler may already have
returned 503, and the provider retry is safely absorbed by the receipt's
semantic dedupe key.

Receipts that are structurally valid but do not belong to this system are acknowledged and counted as unmatched; they must not create a tenant, reveal data, or trigger a retry. Monitor `GET /receipt-health` for `unmatchedCount`, acceptance-unknown, final-delivery-unknown, backlog, budget, circuit, and warnings.

Schedule `ReconcileService.runBatch({ limit })` for delivery-status queries. Reconciliation is a read/repair path for delivery state, not a second send path. Its Alibaba `sendDate` and 30-day eligibility come from the latest authoritative accepted/unknown Attempt's persisted `dispatchMarkedAt`, never the earlier queue submission time. Eligibility is based on `Asia/Shanghai` calendar dates: the current date and preceding 29 dates are queryable. A missing, contradictory, or future dispatch history is deferred as a storage failure instead of querying the wrong date. Administrators can enqueue a targeted reconciliation through `POST /reconcile`; the result is a tenant-scoped job. If that request reuses an existing system job, sms-kit records a durable, narrow `receipt.reconcile` operation/job authorization without rewriting the job origin; `/jobs/:id` still requires that permission and never lets it override an `sms.test` origin. Schedule `MaintenanceService.rollupDirtyDates({ limit })` and `MaintenanceService.applyRetention({ batchSize })` to keep aggregate statistics useful while applying the configured retention policy.

`GET /messages/:id` returns the tenant-authorized, redacted operational
timeline: stable attempt state/times, provider request IDs, stable sms-kit error
codes, receipt source/status/times, and finite redaction diagnostics. It never
returns dispatch/lease tokens, provider messages, raw callback payloads,
plaintext or encrypted phones, template-variable values, or ciphertext.

Use the admin `/stats` route for explicit measurements. It reports `submitted`, `accepted`, `acceptanceRejected`, `acceptanceUnknown`, `deliveryWaiting`, `delivered`, `deliveryFailed`, `deliveryUnknownFinal`, and `retry`, with derived rates when meaningful. Never collapse provider acceptance into final delivery.

## Testing without a provider

Use `sms-kit/testing` only from Node/Vitest code. It exports `FakeClock`, `SequenceIdGenerator`, `createSafeMessageFixture`, and `runSmsStoreContract`; the fixture helpers intentionally avoid plaintext phone numbers and render values. Exercise provider behavior through an injected test implementation rather than a live account. The package's compatibility suite additionally proves that server-only entries cannot enter a Next Client Component.

Keep live-test environment variables unset in local development and CI. The guarded live commands below are the only paths that may contact Aliyun.

## Better Auth phone-number callbacks

`better-auth` is an optional peer dependency. Keep tenant and trusted-IP resolution at the server boundary. The host owns Better Auth's user-phone fields and its Better Auth schema migration; applying sms-kit's migrations does not create or backfill those fields. The host's existing-phone query must be tenant-scoped and must only permit login/reset delivery for an account that already exists.

Build the Better Auth instance from the policy snapshot that applies to that instance. Better Auth 1.7.4 reads `otpLength`, `expiresIn`, and `allowedAttempts` when the instance is constructed. If a host allows those values to change at runtime, it must rebuild its auth instance through its ordinary configuration lifecycle. SMS kit's per-send limits, budget, and circuit settings remain dynamic and are evaluated on every request.

```ts
import { betterAuth } from "better-auth";
import { phoneNumber } from "better-auth/plugins";
import {
  createBetterAuthSmsAdapter,
} from "sms-kit/better-auth";

const adapterOptions = {
  sendService,
  resolveTenant: (context) => tenantFromTrustedSession(context),
  resolveTrustedIp: (context) => ipFromTrustedProxy(context),
  resolveOtpIssuance: (input) => betterAuthIssuances.resolveExact(input),
  isExistingPhone: (tenantId, phone) => users.existsByPhone(tenantId, phone),
  scheduler: { schedule: (task) => waitUntil(task()) },
  transaction: (work) => smsStore.transaction(work),
  rateLimits: smsStore.rateLimits,
  policy: smsStore.policy,
  hasher,
  clock,
  sleeper,
  events,
  templates: {
    login: "auth.login_otp",
    passwordReset: "auth.password_reset",
  },
};
const callbacks = createBetterAuthSmsAdapter(adapterOptions);
const policy = await policyService.get(systemActor);

const auth = betterAuth({
  // database, secret, baseURL, and other host-owned Better Auth options
  plugins: [phoneNumber({
    sendOTP: callbacks.sendOTP,
    sendPasswordResetOTP: callbacks.sendPasswordResetOTP,
    otpLength: policy.otpLength,
    expiresIn: policy.otpTtlSeconds,
    allowedAttempts: policy.otpMaxAttempts,
  })],
});
```

`resolveOtpIssuance` is required and must return `{ id, expiresAt }` for the exact Better Auth verification record created for this callback. The ID is opaque, durable, stable across retries and processes, and unique for every new issuance even when Better Auth generates the same digits. Capture or assign that ID in Better Auth's `databaseHooks.verification.create.before` hook and carry it through trusted request-local state to the callback; do not query the latest record by phone, accept a client header, invent a fresh callback nonce, or rely on a process-local cache as the authority. The adapter validates expiry both before scheduling and immediately before sending, returning only its generic safe envelope on failure.

The direct-send key is a versioned keyed HMAC over tenant, purpose, normalized phone, and issuance ID; OTP digits are deliberately absent and neither the raw ID nor raw HMAC input is persisted or logged. PostgreSQL's tenant/message uniqueness then suppresses duplicate callbacks durably while distinct issuances remain distinct. Callback retries still traverse the request anti-abuse limits before account lookup. Keep the HMAC key stable until every issuance and scheduled callback made with it has expired or completed.

Expose those same host-owned mappings to the admin verification read model;
do not duplicate them as invented database fields:

```ts
const betterAuthVerification = {
  get: async () => ({
    adapterStatus: "enabled",
    loginTemplateKey: adapterOptions.templates.login,
    passwordResetTemplateKey: adapterOptions.templates.passwordReset,
  }),
};

const smsAdminServices = {
  task3: smsTask3Services,
  task4: { ...smsTask4Services, betterAuth: betterAuthVerification },
};
```

Without this source, `GET /verification` truthfully reports
`adapterStatus: "not_configured"` and null mappings. Better Auth mappings are
read-only in this endpoint—`PATCH /verification` updates sms-kit policy only.
If the host makes mappings editable elsewhere, it must persist them in its own
validated configuration and rebuild the adapter through its normal lifecycle.

`waitUntil` above is a host/platform scheduler injection, not a browser API. It must register the task with the request's real lifetime primitive, observe rejected registration, and keep the provider task server-side. Do not invoke an SMS provider from an untrusted client. Configure approved verification templates before enabling this integration: `auth.login_otp` (`better-auth:login`), `auth.password_reset` (`better-auth:passwordReset`), `auth.password_change` (`auth.password_change`), and `auth.step_up` (`auth.step_up`) must each be an approved verification template with the `code` variable. No live SMS provider is necessary for integration tests; use a recording fake provider as in `test/integration/auth/auth-flows.test.ts`.

Do not add a `signUpOnVerification` property to this object. In Better Auth 1.7.4 it is an object configuration when enabled, so `false` is not a valid way to disable registration.

Better Auth 1.7.4's `/phone-number/request-password-reset` route looks up the user and returns before invoking `sendPasswordResetOTP` for an unknown phone, so callbacks alone cannot equalize that route. Create the complete-route guard and install it before routing to Better Auth. Parse the reset body using the same validation as the route; `context` must come only from trusted request state (a request-local host may pass `undefined`).

```ts
import { createBetterAuthPasswordResetPreRouteGuard } from "sms-kit/better-auth";

const resetGuard = createBetterAuthPasswordResetPreRouteGuard(adapterOptions);

if (request.method === "POST" && new URL(request.url).pathname.endsWith("/phone-number/request-password-reset")) {
  const { phoneNumber } = parsePasswordResetBody(await request.clone().json());
  return resetGuard.run({
    phoneNumber,
    context: undefined,
    next: () => auth.handler(request),
  });
}
return auth.handler(request);
```

The guard performs the tenant, phone, and trusted-IP limits and tenant-scoped lookup before the route, then applies one response envelope around known and unknown branches. While using this guard, do **not** configure Better Auth's `advanced.backgroundTasks.handler` on that auth instance: 1.7.4 detaches the reset callback through that handler, allowing the route to finish before the guard can observe scheduling or share its preflight. Better Auth can also catch a rejected callback internally; the adapter records a synchronous scheduling failure in shared guard state and the guard returns a safe `STORAGE_FAILURE` after the route finishes. A provider failure after scheduling remains asynchronous and is emitted only as a redacted event. The adapter only schedules delivery for an existing account and never exposes account existence through its callback result.

## Password changes and generic step-up

Use `ChallengeService` for password change (`action: "password.change"`) and generic step-up (`action: "step.up"`). After a successful verification, consume the returned proof with the same tenant, authenticated subject, action, and one host-operation `consumptionKey`. Never take any of these bindings from a client request.

When the host and sms-kit share PostgreSQL, put proof consumption and the protected write in one transaction. `execute` is used only for the first consumption; `replay` must read the already-written result and must not repeat the mutation:

```ts
await withPgProofTransaction(pool, proofService, {
  tenantId: trustedTenantId,
  proof,
  subjectId: trustedSession.user.id,
  action: "password.change",
  consumptionKey: `password-change:${requestId}`,
}, {
  execute: (client) => changePassword(client, trustedSession.user.id),
  replay: (client) => readPasswordChangeResult(client, requestId),
});
```

For a cross-database protected write, do not use `withPgProofTransaction`. Consume with `proofService.consume` and make the downstream operation durably idempotent with exactly the same `consumptionKey`; persist/reconcile the operation outcome so a retry can compensate for a failure between systems. A step-up consumer follows the same pattern with `action: "step.up"`; a password-change proof must never authorize a step-up action, another user, or another tenant.

## Aliyun live checks

Use a restricted test account, an approved signature whose name contains `测试` or `test`, an approved notification template whose name contains the same marker, and a test recipient you control. The message scenario sends one real SMS through Aliyun; Aliyun does not provide a no-delivery mode for `SendSms`. The checks do not change provider configuration or delete resources.

Previously exposed Aliyun credentials must be revoked and replaced before testing. Never put AccessKey values in this repository, a committed `.npmrc`, test source, command arguments, logs, or this file. Supply them only through your runtime secret manager/environment. Live credential references must use `env://NAME`, and the referenced variable name must include `TEST`; use credentials scoped to a non-production account.

For the read-only connection check, provide `SMS_KIT_LIVE_NON_PRODUCTION=1`, `SMS_KIT_LIVE_CONNECTION_TEST=1`, and both credential-reference values below. It calls Aliyun's signature and template listing APIs and never sends a message:

```sh
npm run test:live:connection --workspace sms-kit
```

For the one-message scenario, also set every value in this table. It validates the signature and notification template from Aliyun before sending, and rejects a recipient not in the explicit allowlist.

| Variable | Required value |
| --- | --- |
| `SMS_KIT_LIVE_TEST` | `1` to enable the send suite |
| `SMS_KIT_LIVE_NON_PRODUCTION` | `1` to attest that credentials and resources belong to a non-production test account |
| `SMS_KIT_LIVE_ALLOW_SEND` | `1` to explicitly authorize the single SMS |
| `SMS_KIT_LIVE_ACCESS_KEY_ID_REF` | An environment reference such as `env://SMS_KIT_TEST_ACCESS_KEY_ID` |
| `SMS_KIT_LIVE_ACCESS_KEY_SECRET_REF` | An environment reference such as `env://SMS_KIT_TEST_ACCESS_KEY_SECRET` |
| `SMS_KIT_TEST_ACCESS_KEY_ID` | AccessKey ID supplied at runtime; do not commit it |
| `SMS_KIT_TEST_ACCESS_KEY_SECRET` | AccessKey Secret supplied at runtime; do not commit it |
| `SMS_KIT_LIVE_PHONE` | Mainland China test recipient in your control |
| `SMS_KIT_LIVE_PHONE_ALLOWLIST` | Comma- or whitespace-separated recipients; must include the test recipient exactly |
| `SMS_KIT_LIVE_SIGN_NAME` | Approved test signature name containing `test` or `测试` |
| `SMS_KIT_LIVE_TEMPLATE_CODE` | Code of the approved test notification template |
| `SMS_KIT_LIVE_TEMPLATE_PARAMS` | JSON object of string values matching the template variables |

Run the one-message scenario with:

```sh
npm run test:live --workspace sms-kit
```

The scenario performs read-only connection/resource checks first, then sends at most one message in the test process. Its output includes only a masked recipient and masked template code. Keep all test-only flags unset for normal development and CI runs.

The send scenario requires Docker and creates a disposable PostgreSQL 17 test database. It exercises configuration, checksummed resource import, encrypted notification enqueue, worker dispatch, budget reservation, Attempt persistence, audit and daily statistics through the normal services. The database and ephemeral encryption keys are discarded afterward. Acceptance also schedules the normal reconciliation job; this test does not wait for final delivery.

Health snapshots accept an injected `clock`. By default, pending jobs older than five minutes, waiting messages with no fresh callback for one hour, unavailable resources, and a daily budget with at most 10% remaining degrade readiness. The backlog and callback windows can be set with `backlogStaleMs` and `receiptStaleMs`.
