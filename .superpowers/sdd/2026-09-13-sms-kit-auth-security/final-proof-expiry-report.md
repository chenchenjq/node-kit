# Final Auth Security report — proof expiry after row-lock acquisition

## Root cause

`ProofService.consume()` evaluated its injected `Clock` before
`PgChallengeRepository.consumeProof()` issued `SELECT ... FOR UPDATE`. A consumer that began
before proof expiry could therefore wait behind another transaction until after expiry and still
consume the proof with the stale timestamp.

## Fix

- Changed the challenge-repository consumption contract to receive a deferred `now()` callback.
- `ProofService` passes its injected clock through that callback instead of capturing a timestamp.
- The PostgreSQL repository evaluates the callback only after `SELECT ... FOR UPDATE` has acquired
  the challenge row lock, then uses that single current timestamp for both expiry validation and
  `consumed_at`.
- Existing transaction ownership, rollback, competing-key rejection, and same-key replay behavior
  remain unchanged.

## Deterministic PostgreSQL regression

The new integration test:

1. creates a verified proof with a five-minute lifetime;
2. opens a holder transaction and locks that proof's challenge row;
3. starts `withPgProofTransaction()` and waits until PostgreSQL reports the consumer as blocked by
   the holder through `pg_blocking_pids`;
4. advances the injected test clock beyond `proof_expires_at`;
5. rolls back the holder transaction; and
6. verifies that consumption rejects with `PROOF_INVALID`, `execute` is never invoked, and
   `consumed_at` / `consumed_by_key` remain null.

## TDD evidence

- RED: `npm run test:integration --workspace sms-kit -- proof-transaction.test.ts` failed because
  the blocked consumer resolved to `"executed"` after the clock advanced past expiry.
- GREEN: the same command passed all 5 tests after moving clock evaluation behind row-lock
  acquisition.

## Final verification

- `npm test --workspace sms-kit` — 22 files, 123 tests passed.
- `npm run test:integration --workspace sms-kit` — 18 files, 140 tests passed.
- `npm run typecheck --workspace sms-kit` — passed.
- `npm run build --workspace sms-kit` — passed.
- `git diff --check` — passed.
