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
- `node --input-type=module -e 'await import("./packages/sms-kit/dist/core/index.js")'` — passed (`core import ok`) while the Better Auth adapter remains a separate optional-peer entry point.

`better-auth` 1.7.4's declaration dependencies are not compatible with this repository's TypeScript 7 checker when library checking is enabled, so the package build/typecheck configurations now skip third-party declaration checking while retaining checking for SMS Kit source and contract tests.
