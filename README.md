# sms-kit

Private Node.js SMS toolkit with an Alibaba Cloud (Aliyun) provider. The package's default `npm test --workspace sms-kit` does not contact Aliyun. Live tests use separate scripts and are skipped unless explicitly opted in.

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
  isExistingPhone: (tenantId, phone) => users.existsByPhone(tenantId, phone),
  scheduler: { schedule: (task) => waitUntil(task()) },
  transaction: (work) => smsStore.transaction(work),
  rateLimits: smsStore.rateLimits,
  policy: smsStore.policy,
  hasher,
  clock,
  sleeper,
  events,
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
