# Task 1 report — issue and verify high-risk challenges

## Delivered

- Added cryptographically unbiased, zero-padded OTP generation using `crypto.randomInt`.
- Added `ChallengeService.issue` and `ChallengeService.verify`, backed by the fenced `SendService.sendOtpNow` path.
- Snapshotted policy version, OTP length, OTP/proof TTLs, and maximum attempts in each challenge.
- Enforced transactional tenant, phone/purpose, IP, and tenant-window limits before OTP generation.
- Persisted only keyed hashes for OTPs and 32-byte proofs; proof hashes bind tenant, subject, and action.
- Serialized verification with a PostgreSQL row lock, atomically recording wrong attempts and one-time verification.
- Invalidated challenges after rejected or acceptance-unknown direct delivery. Unknown acceptance returns a fresh-request instruction and never auto-resends on idempotent replay.
- Added migration 0005 and migration-test expectations for the new schema version.

## Review remediation (round 1)

- Added migration 0006, which persists `pending`/`accepted`/`rejected`/`unknown` direct-delivery acceptance state and safe terminal error codes. Terminal errors are no longer constrained to only provider-rejected/unknown, so throttling, configuration, rate, and budget outcomes can replay exactly.
- A challenge is verifiable only after its direct message is accepted. Pending deferred dispatches, rejected/unknown acceptance, and invalidated challenges cannot issue or consume a proof.
- Serialized challenge idempotency by a tenant-scoped PostgreSQL transaction advisory lock before lookup/create. Concurrent retries now observe the same persisted request outcome.
- Persisted policy/rate/circuit terminal outcomes atomically with a non-OTP sentinel hash; no OTP is generated or retained for those rejected requests.
- Loaded one selected policy snapshot for challenge enforcement and challenge recording, eliminating a second policy read.
- Updated the store contract’s already-verified proof fixture to explicitly model accepted delivery.

## Review remediation (round 2)

- Replays of a pending direct dispatch now poll the persisted challenge acceptance state and return the original accepted, rejected, or unknown outcome; the transaction advisory lock is released before the provider network call.
- Pending replay recovery is bounded (30 seconds in production). A replay that still observes `pending` then locks the challenge row and atomically records `ACCEPTANCE_UNKNOWN`; a late provider response observes that terminal outcome instead of making the challenge verifiable.
- Added deterministic PostgreSQL deferred-provider regressions for accepted, rejected, unknown, and stale/crashed-pending replay cases.

## TDD evidence

- RED: OTP unit test failed because `otp-generator` was absent.
- RED: challenge integration test failed because `challenge-service` was absent.
- RED: snapshot persistence test failed because TTL snapshot columns were absent.
- RED: acceptance-unknown replay test failed until the fresh-request instruction was added.

## Verification

- `npm test --workspace sms-kit` — 19 files, 108 tests passed.
- `npm run test:integration --workspace sms-kit` — 15 files, 122 tests passed.
- `npm run typecheck --workspace sms-kit` — passed.
- `npm run test:integration --workspace sms-kit -- challenge-service.test.ts` — 12 tests passed (real PostgreSQL, including deferred provider, concurrent retry, throttled replay, rate replay, and policy snapshot regressions).
- `npm run test:integration --workspace sms-kit -- store-contract.test.ts` — 21 tests passed.
- `npm test --workspace sms-kit` — 19 files, 108 tests passed.
- `npm run build --workspace sms-kit` — passed.
- `npm run test:integration --workspace sms-kit -- challenge-service.test.ts` — 15 tests passed (including deferred terminal-outcome replay and bounded crash recovery).
