# Task 6 report — bounded Aliyun delivery receipt ingestion

## Delivered

- Added strict, byte-bounded parsing for Alibaba Cloud mainland `SmsReport`
  callback batches. The parser projects away `phone_number`; it accepts only
  documented fields and retains delivery-relevant values.
- Added `ReceiptService.ingest({ token, body, deadlineAt })`, with a decoded
  32-byte base64url callback token compared by `timingSafeEqual`, deadline
  fencing before parse and transaction start, and Alibaba's `{ code: 0, msg:
  "成功" }` acknowledgement for valid work.
- Receipt matching locks a message only when its persisted opaque message
  `out_id` and provider BizId both match. The callback never supplies a tenant
  and never matches on its phone number.
- Added deterministic receipt dedupe (provider, BizId, report timestamp,
  outcome, and provider code), transactional matched receipt/state updates,
  idempotent unmatched storage, and safe aggregate events for unmatched and
  terminal-conflict reports. A terminal receipt conflict is recorded without
  regressing the already-final message.

## TDD evidence

- RED: `receipt.test.ts` first failed because `src/aliyun/receipt.ts` did not
  exist. `receipt-service.test.ts` then failed because the ingestion service
  was absent.
- GREEN: parser coverage includes strict shape, byte bounds, and phone
  projection. PostgreSQL integration coverage includes bad-token precedence,
  concurrent dedupe, idempotent unmatched acknowledgement, injected deadline
  exhaustion, and terminal conflict preservation.

## Verification

```text
npm test --workspace sms-kit -- test/unit/aliyun/receipt.test.ts
# 1 file, 3 tests passed

npm run test:integration --workspace sms-kit -- receipt-service.test.ts
# 1 file, 5 tests passed (real PostgreSQL)

npm run build --workspace sms-kit
# exit 0

git diff --check
# exit 0
```

## Security and ownership

- The callback token is only a bounded, constant-time compared admission
  signal; ownership is derived from the two stored opaque provider references.
- `phone_number` is neither returned nor persisted. Receipt diagnostics are
  restricted to the existing finite redaction/aggregate-metric schema.
- Unmatched receipts remain unscoped system records and are acknowledged to
  prevent provider retry storms; matched receipt ownership is derived from the
  locked message inside the same transaction.

## Fix round 1

- An earlier unmatched row can now be atomically promoted after the message's
  accepted dispatch references are durable and a later callback proves both
  opaque identifiers. Promotion keeps one receipt row, derives its tenant from
  the locked message, and runs the otherwise-idempotent delivery transition.
- `err_msg` remains structural input only and is no longer passed to receipt
  persistence. Persisted diagnostics retain the finite redacted payload, never
  provider-controlled raw message text.
- `Uint8Array.byteLength` is checked before a `Buffer` is allocated/decoded.
  Both `send_time` and `report_time` require real Gregorian calendar values;
  impossible normalizable dates are rejected.
- Event-sink invocation is now detached and exception-safe after a durable
  transaction. A throwing or never-resolving optional observer cannot block
  Alibaba acknowledgement.

Fix-round verification:

```text
npm test --workspace sms-kit -- test/unit/aliyun/receipt.test.ts
# 1 file, 5 tests passed

npm run test:integration --workspace sms-kit -- receipt-service.test.ts
# 1 file, 9 PostgreSQL integration tests passed

npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
# both exit 0
```

## Fix round 2

- Unmatched-row promotion is now constrained inside `PgReceiptRepository`, not
  merely by `ReceiptService`: the candidate row's provider BizId and the target
  message's persisted provider BizId must both equal the supplied opaque
  reference while the message remains tenant-owned by the caller.
- A direct PostgreSQL repository regression proves that an own-tenant message
  cannot claim, return, or disclose an unrelated system-owned unmatched row
  sharing only a dedupe key. The existing early-unmatched then accepted/message
  redelivery flow remains covered and passes.

Verification:

```text
npm run test:integration --workspace sms-kit -- message-job.test.ts
# 1 file, 11 PostgreSQL integration tests passed

npm run test:integration --workspace sms-kit -- receipt-service.test.ts
# 1 file, 9 PostgreSQL integration tests passed

npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
# both exit 0
```
