# Task 7 report — delivery reconciliation, maintenance and health

## Delivered

- Added `ReconcileService.runBatch()` for leased reconciliation work. It only
  leases tenant-owned messages still in a queryable waiting state, opens the
  stored phone with its original protection context, derives Alibaba's
  `Asia/Shanghai` `yyyyMMdd` send date, and queries every indicated 50-item
  page without ever calling the send operation.
- Query receipts are durably deduplicated and stored as query-sourced receipts
  before the delivery state moves. Empty results remain non-authoritative and
  are retried; only messages outside Alibaba's 30-day query window become
  `unknown_final`.
- Added `MaintenanceService` for global dirty-key rollups and bounded
  retention. Rollups recompute absolute UTC-day statistics under versioned
  dirty-key deletion. Retention removes expired challenges, candidates, rate
  buckets and released reservations, clears phone ciphertext/key IDs together,
  and leaves anonymous daily statistics intact.
- Added `HealthService.getSnapshot({ tenantId })`. Tenant job/message/receipt
  facts remain scoped, while unmatched-receipt counts and budget/circuit state
  are system aggregates. The snapshot exposes no credential, phone, provider
  message, or cross-tenant message detail.

## TDD evidence

- RED: new reconciliation and maintenance integration tests first failed
  because their application services did not exist; the health unit test then
  failed for the same reason.
- RED: an additional integration test proved that the original generic job
  lease could lease a stale reconciliation job (`succeeded` rather than the
  expected `pending`).
- GREEN: `leaseReconciliation` now joins the tenant-owned message while
  selecting candidates and accepts only `waiting` messages with `accepted` or
  `unknown` acceptance state.

## Verification

```text
npm run test:integration --workspace sms-kit -- reconcile.test.ts
# 1 file, 2 PostgreSQL integration tests passed

npm run test:integration --workspace sms-kit -- maintenance.test.ts
# 1 file, 2 PostgreSQL integration tests passed

npm test --workspace sms-kit -- health.test.ts
# 1 file, 1 test passed

npm test --workspace sms-kit
# 17 files, 90 tests passed

npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
git diff --check
# all exit 0
```

## Fix round 1

- Delivery queries now preserve all Alibaba detail items for each page. The
  reconciler accepts terminal evidence only when its returned `outId` exactly
  equals the leased message ID; unrelated same-phone/date records cannot move
  another message or tenant.
- Expired reconciliation leases are reclaimable, and every completion remains
  fenced by the current lease token. A stale worker cannot complete reclaimed
  work.
- A positively correlated terminal query atomically promotes an `unknown`
  acceptance to `accepted`, records the query receipt when the persisted BizId
  exists, and updates delivery plus dirty statistics in one transaction.
- Retention now has explicit boundaries: challenges after 7 days; candidates
  and rate buckets at their own expiry; message phones after 90 days; receipt
  payloads, audit events, and released reservations after 180 days. Anonymous
  statistics and held budget enforcement remain intact.
