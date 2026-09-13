# Aliyun Delivery final-review fix report

## Scope

One final fix wave against the Aliyun Delivery plan, SMS PRD, database design,
task reports and final review findings. The plan, progress ledger, immutable
migrations and exposed credential values were not changed or used.

## Findings addressed

1. **Automatic reconciliation:** accepted and unknown OTP responses, and
   accepted queued responses, now create the deduplicated reconcile job in the
   same transaction as dispatch-token-fenced message and Attempt completion.
   Existing queued unknown scheduling remains atomic. Service-level PostgreSQL
   tests send then reconcile without manually creating reconcile jobs. A forced
   scheduling failure rolls message and Attempt completion back together.
2. **Real deadlines:** application sends and the Aliyun adapter use an actual
   timer race. The SDK receives bounded connect/read timeouts with automatic
   SDK retry disabled. Timeout returns acceptance unknown; the losing response
   has no persistence continuation. An aborted adapter operation cannot begin
   its SDK request after delayed credential resolution completes.
3. **Production pagination:** production resource discovery now calls the
   existing strict all-page validators, including response codes, page numbers,
   totals, duplicate identities and partial-page failures. A malformed provider
   response cannot produce a retirement-capable sync preview. Missing success
   codes also fail connection checks.
4. **Approval loss:** existing signatures/templates persist their changed cloud
   status and become disabled; signature revocation disables dependent local
   templates. Existing changed templates are observed even when not explicitly
   selected as new imports. A simultaneous child refresh cannot roll back a
   parent's approval revocation. New unapproved resources remain non-importable.
5. **Worker eligibility:** before creating a dispatch marker, the worker locks
   the message and reads/locks its current template and signature. Enablement,
   cloud approval, purpose, template kind, variable names and stored provider
   identities must still match. Ineligible pending work is rejected and its job
   ended without any Attempt or provider call; budget release is transactional.
6. **Retention:** the 90-day scrub clears render ciphertext and key IDs together
   with phone derivatives and metadata. It locks jobs before messages, defers
   active leases, conservatively handles abandoned dispatch markers, ends old
   queued/reconcile work and dirties statistics in one transaction. Known
   unsent/rejected work releases held budget atomically; unknown/accepted work
   does not release conservative budget accounting. Existing bounded 7/90/180
   day cleanup and anonymous statistics remain intact.
7. **Live scenario:** live and simulated checks now share the actual config,
   policy, resource sync/import, AES-GCM enqueue, worker, reservation, Attempt,
   audit and rollup chain. Each scenario owns a disposable PostgreSQL 17
   container and ephemeral encryption keys. All original opt-in, test-resource,
   allowlist and one-send guards remain; the dispatch boundary checks the exact
   authorized recipient and resources. The scenario verifies acceptance and
   scheduled reconciliation, without claiming final delivery.
8. **Policy bounds:** phone interval is 1–3600 seconds, IP window 60–86400
   seconds, and positive integer capacities use PostgreSQL's signed integer
   ceiling. Boolean circuit validation is explicit; existing circuit-reason
   consistency remains. Unit and real-PG service tests cover invalid boundaries
   and legal maximum capacities.
9. **Provider contract:** recognized SDK rejection errors are mapped once,
   retaining retry classification. Public `parseReceipt` parses bounded real
   SmsReport bodies, preserves opaque OutId correlation, drops phone/free-text
   provider messages and returns the documented acknowledgement.
10. **OTP budget and health:** every explicit final OTP rejection releases its
    reservation, including provider responses otherwise marked retryable.
    Health uses its injected clock for the UTC budget day and evaluates usable
    resources, callback freshness, queue age, budget and circuit/config state.
    Query receipts cannot masquerade as fresh callbacks. Default operational
    thresholds and their overrides are documented in the package README.

The complete suite also exposed three stale migration assertions expecting
schema v3 despite existing migration 0004. Those assertions now expect v4;
no migration SQL or migration ledger was rewritten.

## TDD evidence

- Initial provider/policy regression run: 13 expected failures among 14 tests.
- Initial service + real-PostgreSQL regression run: 11 expected failures among
  13 tests, including absent reconciliation, hanging sends, stale-resource
  dispatch and retained render envelopes.
- Additional focused RED/GREEN checks covered simultaneous parent/child cloud
  changes, query-receipt health freshness, recent reservations on expired work,
  and credential resolution completing after a request deadline.
- The shared live scenario initially failed for the missing implementation,
  then passed with the real services/database and a fake low-level Aliyun API.

## Verification

- `npm test --workspace sms-kit`: **107 passed** across 18 files.
- `npm run test:integration --workspace sms-kit -- --fileParallelism --maxWorkers=2`:
  **109 passed** across all 14 files, using real PostgreSQL 17 containers.
- Final focused PostgreSQL regression + migration + maintenance rerun:
  **27 passed** across 3 files.
- `npm run typecheck --workspace sms-kit`: passed.
- `npm run build --workspace sms-kit`: passed.
- Live scripts with both live flags explicitly disabled: **6 guard tests passed,
  2 real provider suites skipped**.
- `git diff --check`: passed.

## Integration notes and safety

- Custom store adapters need the new `findSignatureById` and
  `rejectUndispatched` repository operations, including their transaction/lock
  semantics. Existing package adapters and typed contracts compile.
- A deadline cannot physically cancel an arbitrary injected Promise. SDK
  transport timeout options bound real SDK I/O; application persistence is
  fenced against eventual late completion regardless of transport behavior.
- No real Aliyun request or SMS was made during this wave. No publish command,
  production database write, credential inspection or credential addition was
  performed. Tests used synthetic secret values and disposable databases.
- Existing untracked dependency/build directories are left uncommitted.
