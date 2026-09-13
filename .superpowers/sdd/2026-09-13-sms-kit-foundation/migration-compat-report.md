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
