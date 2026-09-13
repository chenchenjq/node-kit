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

## TDD evidence

- RED: OTP unit test failed because `otp-generator` was absent.
- RED: challenge integration test failed because `challenge-service` was absent.
- RED: snapshot persistence test failed because TTL snapshot columns were absent.
- RED: acceptance-unknown replay test failed until the fresh-request instruction was added.

## Verification

- `npm test --workspace sms-kit` — 19 files, 108 tests passed.
- `npm run test:integration --workspace sms-kit` — 15 files, 117 tests passed.
- `npm run typecheck --workspace sms-kit` — passed.
