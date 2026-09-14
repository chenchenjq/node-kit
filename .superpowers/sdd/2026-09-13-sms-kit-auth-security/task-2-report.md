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
