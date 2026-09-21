# Foundation migration compatibility repair

## Root cause

The deployed `0002_reliability_policy.sql` checksum was
`2e50eb57308d28d0a0b08cbf5c4b66ad522ea97e8b7ac7c21b854e8c83975c06`.
The final fix inserted v1 lease cleanup into that historical file, changing its
checksum to `28dab9e72d0d2063de7ee8a5e8f53e24296b73f971abfc2dee6e4bdb5a6281be`.
The strict ledger correctly rejected an existing v2 database.

## Repair

- Restored migration 0002 byte-for-byte to its deployed checksum.
- Moved conservative lease fencing into forward migration 0003. Active v2
  leases become `dead`, owner/token/expiry are cleared, and linked pending
  messages become acceptance-unknown instead of retryable.
- Promoted the fixed previous-version fixture to the exact v2 schema with the
  deployed 0002 checksum.
- Added regression coverage for old-v2 upgrade, active lease fencing, and
  rejection of an arbitrary v2 checksum. Fresh bootstrap and ledger-gap tests
  remain covered.

The regression was observed failing with `database migration checksum mismatch`
before restoring 0002, then passing after the forward-migration repair.

## Verification

```text
npm test --workspace sms-kit                         # 9 files, 45 tests passed
npm run test:integration --workspace sms-kit        # 5 files, 35 tests passed
npm run typecheck --workspace sms-kit                # passed
npm run build --workspace sms-kit                    # passed
sha256sum 0002_reliability_policy.sql                # 2e50eb...75c06
git diff --check                                     # passed
```

## Re-review repair

The first repair still let a v1 leased row reach immutable migration 0002,
where the new lease-state constraint rejected its missing `lease_token` before
0003 could run. It also made 0003 overwrite an already-terminal delivery state
with `waiting`.

- Checksum verification now returns the exact verified ledger version sequence.
  Only a ledger equal to `[1]` enters a transaction-local legacy preflight,
  after checksum verification and under the migration advisory lock. The
  preflight uses only v1 columns, fences leased jobs as `dead`, and then lets the
  unchanged published 0002 run. Empty, v2, gapped, and checksum-mismatched
  ledgers cannot select this branch.
- Both the v1 preflight and 0003 change delivery to `waiting` only from
  `not_applicable`; `delivered`, `failed`, `unknown_final`, and existing
  `waiting` states are preserved.
- Added an exact v1 fixture plus linked `pending + delivered` lease regression.
  The v2 fixture/checksum regression remains and now also proves terminal
  delivery preservation.
- The reusable `runSmsStoreContract` now runs against both multi-tenant IDs and
  IDs resolved through `FixedTenantContext`. Each case gets isolated PostgreSQL
  state, so the version-zero provider configuration bootstrap path is exercised
  in both lanes; the dedicated configuration integration test remains intact.

RED evidence: the v1 migration failed inside 0002, the v2 assertion received
`delivery_status = waiting`, and the initial fixed-tenant shared-contract run
failed its multi-tenant assumptions and accumulated statistics. Final checks:

```text
npm test --workspace sms-kit                         # 9 files, 45 tests passed
npm run test:integration --workspace sms-kit        # 5 files, 46 tests passed
npm run typecheck --workspace sms-kit                # passed
npm run build --workspace sms-kit                    # passed
sha256sum 0002_reliability_policy.sql                # 2e50eb...75c06
git diff --check                                     # passed
```

## Residual configuration bootstrap repair

`PgConfigRepository.update()` previously applied `expectedVersion` only to the
`ON CONFLICT DO UPDATE` branch. When the singleton row was absent, PostgreSQL
executed the INSERT branch for any expected version.

The repository now uses two explicit optimistic paths: version zero may
`INSERT ... ON CONFLICT DO NOTHING`, while every nonzero version performs an
UPDATE-only statement with `WHERE id = 1 AND version = expectedVersion`. Both
zero-row outcomes retain the existing `CONCURRENT_MODIFICATION` contract.

The shared Store contract now tries `expectedVersion: 1` against an absent
singleton before the valid version-zero bootstrap. The regression first failed
in both multi-tenant and fixed-default-tenant lanes because the invalid update
resolved with a newly inserted version-one row, then passed after the split.

```text
npm test --workspace sms-kit                         # 9 files, 45 tests passed
npm run test:integration --workspace sms-kit -- config-resource.test.ts store-contract.test.ts
                                                     # 2 files, 26 tests passed
npm run typecheck --workspace sms-kit                # passed
npm run build --workspace sms-kit                    # passed
git diff --check                                     # passed
```
