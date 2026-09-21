# Aliyun Delivery final reconciliation cleanup report

## Root cause

Accepted and acceptance-unknown sends create a deduplicated reconciliation job.
A terminal callback then moves the message from `waiting` to `delivered` or
`failed`, but `leaseReconciliation()` previously selected only `waiting`
messages. The associated pending job therefore remained permanently visible to
backlog and health queries.

## Repair

- Reconciliation leasing now includes terminal delivery states for messages
  whose acceptance is `accepted` or `unknown`.
- The existing service path detects that such a message is no longer queryable
  and succeeds the job without opening protected data or calling Alibaba.
- Selection still joins job and message on both message ID and tenant ID.
  Completion remains fenced by tenant, job ID, and the newly issued lease token;
  an active lease is not stolen before expiry and its former token cannot mutate
  the reclaimed job.
- Rejected/not-applicable messages remain excluded.

## Regression coverage

The real PostgreSQL final-regression suite now exercises the complete lifecycle:
accepted direct send, automatic reconciliation scheduling, active lease,
idempotent delivered callback, lease expiry, terminal job cleanup, and health
backlog removal. It also proves that cleanup makes no provider query, a stale
token is fenced, duplicate callbacks store one receipt, and a mismatched-tenant
job referencing the same message is untouched.

TDD RED failed with `runBatch()` returning `0` instead of `1`. After the lease
predicate repair, the same focused suite passed all 18 tests.

## Verification

- `npm test --workspace sms-kit`: 107 passed across 18 files.
- `npm run test:integration --workspace sms-kit -- --fileParallelism --maxWorkers=2`:
  110 passed across 14 files using real PostgreSQL.
- Focused receipt, reconciliation, and final-regression PostgreSQL suites: 32
  passed across 3 files.
- `npm run typecheck --workspace sms-kit`: passed.
- `npm run build --workspace sms-kit`: passed.

No live Alibaba request, publish command, credential inspection, or production
database write was performed.
