# Task 2 report — transaction-safe proof consumption

## Delivered

- Added `ProofService.consume`, which hashes the full tenant, subject, action, and proof binding before repository lookup and maps every non-successful consumption result to `PROOF_INVALID`.
- Added same-key replay semantics: a consumed proof returns `replay: true` only when the exact original `consumptionKey` is reused; a distinct key is rejected.
- Added `withPgProofTransaction(pool, proofService, input, work)` for same-PostgreSQL-database operations. It consumes the proof and executes the host callback on one `PoolClient`, committing both together or rolling both back.
- Documented the cross-database compensation contract in the exported API: the downstream write must be idempotent with the exact `consumptionKey`; the helper makes no cross-database atomicity claim.

## TDD evidence

- RED: the new integration suites initially failed because `proof-service` and `proof-transaction` did not exist.
- GREEN: service coverage proves same-key replay, distinct-key rejection, concurrent same-key serialization, and non-consuming tenant/subject/action mismatches.
- GREEN: PostgreSQL coverage proves a callback exception rolls back proof consumption and that the callback receives the transaction-owning host client.

## Verification

- `npm run test:integration --workspace sms-kit -- proof-service.test.ts` — 6 passed.
- `npm run test:integration --workspace sms-kit -- proof-transaction.test.ts` — 2 passed.
- `npm run typecheck --workspace sms-kit` — passed.
- `npm run build --workspace sms-kit` — passed.

## Fix round 1 — same-database replay fence

- Root cause: `withPgProofTransaction` received the proof replay result but always invoked the single host callback, so a same-key replay could repeat a host mutation.
- The helper now requires separate `execute` and `replay` functions. It invokes `execute` only for the first consumption and invokes `replay` only for a same-key replay, both while the proof row remains transaction-locked. This makes an unguarded replay mutation impossible through the helper API.
- Added real PostgreSQL regressions for repeated and concurrent same-key host operations (one inserted host row), concurrent competing keys (exactly one success), and a host insert followed by a thrown error (both host row and proof consumption roll back).
- Cross-database guidance remains unchanged: callers must use the exact `consumptionKey` as the downstream idempotency key.
