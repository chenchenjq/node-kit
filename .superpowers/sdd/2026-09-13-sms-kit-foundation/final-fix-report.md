# Foundation final-fix report

## Corrections

- `completeAcceptance()` now changes `delivery_status` only from `not_applicable`; a receipt or reconciliation terminal state is retained. `accepted_at` is written only when acceptance becomes `accepted`.
- Budget holds lock policy before every return, including owned existing reservations. They validate and lock the tenant-owned message before touching a budget row, so foreign messages or reservations cannot consume global capacity or return success.
- Shared runtime projectors strip unknown and nested values before message metadata, configuration test-summary, audit metadata, and receipt-payload JSONB writes.
- Fresh stores return a defined `unconfigured` provider singleton at version zero. The first optimistic update inserts it; integration setup no longer raw-SQL-seeds provider configuration.
- Repeated unmatched receipts return `created: false` with a synthetic, unscoped acknowledgement built only from caller input; no existing system receipt is read or disclosed.
- Migration 0002 fences v1 `leased` jobs as terminal `dead` work with `ACCEPTANCE_UNKNOWN`; linked pending messages become conservatively acceptance-unknown and waiting, avoiding retry of a potentially dispatched tokenless lease.
- Testcontainers now uses `postgres:17-alpine`. `test:contract` now has a Docker-free fixed-tenant/public-port lane, and the reusable Store contract asserts unmatched duplicate acknowledgement semantics.

## Regression coverage

- Receipt-before-accepted-response retains `delivered`; `unknown_final -> accepted` retains `unknown_final`; rejected and unknown acceptance completions leave `accepted_at` absent.
- Foreign budget holds, circuit-open existing reservations, JSONB projection, post-migration configuration initialization, v1 leased-job upgrade, and unmatched duplicate privacy behavior are integration-tested.

## Verification

```text
npm test --workspace sms-kit                         # 9 files, 45 tests passed
npm run test:contract --workspace sms-kit            # 1 file, 2 tests passed
npm run test:integration --workspace sms-kit -- message-job.test.ts      # 10 passed
npm run test:integration --workspace sms-kit -- policy-budget.test.ts    # 4 passed
npm run test:integration --workspace sms-kit -- config-resource.test.ts  # 5 passed
npm run test:integration --workspace sms-kit -- store-contract.test.ts   # 11 passed
npm run test:integration --workspace sms-kit -- migration.test.ts        # 5 passed
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
git diff --check
```
