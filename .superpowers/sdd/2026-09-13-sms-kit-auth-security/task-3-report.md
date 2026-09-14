# Task 3 report — Better Auth SMS adapter

## Delivered

- Added the optional `sms-kit/better-auth` adapter with callbacks derived directly from Better Auth 1.7.4's `phoneNumber()` option types.
- Normalizes mainland-China phone numbers; resolves tenant and IP only from trusted server context; and performs tenant-scoped account lookup only after transactional phone, IP, and tenant request limits.
- Schedules an unstarted direct-send task only for existing accounts. Its idempotency key contains a host-provisioned keyed-HMAC digest of tenant, normalized phone, and callback OTP; the plaintext components are not persisted or emitted by the adapter.
- Uses stable `auth.login_otp` and `auth.password_reset` defaults, deterministic 250 ms response envelopes, and redacted `STORAGE_FAILURE` diagnostics for scheduler and background-send failures.
- Documented the Better Auth callback wiring without configuring automatic verification signup.

## TDD evidence

- RED: focused adapter/type contracts failed because `createBetterAuthSmsAdapter` was not exported.
- RED: the response-envelope contract failed while the default delay was zero.
- GREEN: template selection, unknown-account non-send, idempotency-key reuse, ordered limits, safe scheduler failure handling, response envelopes, and real-plugin typing now pass.

## Verification

- `npm run test:contract --workspace sms-kit -- better-auth-adapter.test.ts better-auth-types.test.ts` — 3 files, 9 tests passed.
- `npm run typecheck --workspace sms-kit` — passed.
- `npm run build --workspace sms-kit` — passed.

## Fix round 2

- Reset-route guards now create one response-envelope state and pass it through the asynchronous request context. A guarded `sendPasswordResetOTP` callback reuses the outer deadline instead of sleeping again, so known and unknown reset requests make one identical envelope delay while rate limits are charged once.
- The shared state records all synchronous guarded callback failures. Better Auth 1.7.4 catches `runInBackgroundOrAwait` callback rejections even without a background-task handler; after the real route returns, the guard inspects that state and emits a fresh safe `STORAGE_FAILURE`.
- Initial `clock.now()` acquisition is inside the safe envelope boundary for both callbacks and guards.
- Added advancing-clock coverage for one reset envelope and a real in-memory Better Auth phone-plugin route regression for swallowed scheduler rejection.

## Fix-round-2 verification

- `npm run test:contract --workspace sms-kit -- better-auth-adapter.test.ts better-auth-optional-peer.test.ts better-auth-types.test.ts` — 4 files, 17 tests passed.
- `npm run typecheck --workspace sms-kit` — passed.
- `npm run build --workspace sms-kit` — passed.
- `node --input-type=module -e 'await import("./packages/sms-kit/dist/core/index.js")'` — passed (`core import ok`) while the Better Auth adapter remains a separate optional-peer entry point.

`better-auth` 1.7.4's declaration dependencies are not compatible with this repository's TypeScript 7 checker when library checking is enabled, so the package build/typecheck configurations now skip third-party declaration checking while retaining checking for SMS Kit source and contract tests.

## Fix round 1

- Centralized callback and pre-route error handling in one deterministic envelope. Every failure leaving either surface is a newly allocated, redacted `STORAGE_FAILURE`; no host error message, fields, cause code, or error object is rethrown. Sleeper failures now have the same safe result after known and unknown branches.
- Added `createBetterAuthPasswordResetPreRouteGuard()`. It wraps the complete `/phone-number/request-password-reset` route, which is necessary because Better Auth 1.7.4 deliberately skips `sendPasswordResetOTP` for unknown users. The existing-account callback reuses the guard's async request preflight instead of charging limits twice.
- Documented that `advanced.backgroundTasks.handler` must not be configured on the guarded Better Auth instance: the 1.7.4 route detaches the callback through that handler, preventing guarded request error propagation and reliable preflight reuse.
- Added a fixture that builds `sms-kit`, copies only its `core` export plus its real `libphonenumber-js` dependency into a temporary package, asserts `better-auth` is physically absent there, and successfully imports `sms-kit/core`.

## Fix-round verification

- `npm run test:contract --workspace sms-kit -- better-auth-adapter.test.ts better-auth-optional-peer.test.ts better-auth-types.test.ts` — 4 files, 14 tests passed.
- `npm run typecheck --workspace sms-kit` — passed.
- `npm run build --workspace sms-kit` — passed.
