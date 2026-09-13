# Task 2 Report: Aliyun resource discovery

Implemented complete paginated discovery and safe resource mapping for Aliyun SMS signatures and templates.

## Behavior

- Added `listAllAliyunSignatures()` and `listAllAliyunTemplates()`. They request pages with incrementing `pageIndex`, continue until the reported total is consumed or an empty page ends an uncounted listing, and return resources sorted by stable external key and normalized value.
- Discovery validates success codes, page arrays, totals, and mapped resource fields. Transport errors, unsupported provider data, inconsistent totals, and pagination gaps reject with `PROVIDER_UNAVAILABLE`; no partial resource snapshot is returned.
- Signature business types are limited to `验证码类型` and `通用类型`. External keys use `orderId` when present and otherwise use the URL-safe SHA-256 digest of `[businessType, signName]`, keeping identical names with different types distinct.
- Template imports accept only `(templateType, outerTemplateType)` pairs `(0, 1)` as notification and `(2, 0)` as verification. Marketing, international/HK/Macao/Taiwan, conflicting, missing, and unknown pairs are rejected.
- Updated the narrow API aliases to include SDK 4.6.0 `orderId` and `outerTemplateType`; resource helpers and mapping functions are exported from the Aliyun barrel. Provider page mapping now shares the strict mapping functions.

## Tests and verification

- TDD RED: the new test suite failed because `resource-map.js` did not exist.
- TDD GREEN: `npm test --workspace sms-kit -- test/unit/aliyun/resources.test.ts` passed, 14 tests.
- `npm run typecheck --workspace sms-kit` passed.
- The full Aliyun unit-test directory passed, 22 tests across 3 files.
- `git diff --check` passed.

The tests use the installed SDK 4.6.0 response model types so relevant SDK field changes are checked by TypeScript.

## Review fix round 1

- Added RED regressions proving discovery previously accepted duplicate external keys and a second response that repeated page 1 despite requesting page 2. Both now reject with `PROVIDER_UNAVAILABLE`.
- Complete discovery now verifies each present `currentPage` equals the requested page and rejects duplicate normalized external keys before returning a snapshot.
- `SmsProvider.listSignatures()` and `listTemplates()` now translate mapper validation failures to `SmsKitError` with code `PROVIDER_UNAVAILABLE`.
- Focused RED run: 4 expected failures across the new duplicate-key, page-number, and provider mapping error cases.
- GREEN verification: Aliyun unit suite passed, 26 tests across 3 files; `npm run typecheck --workspace sms-kit` and `git diff --check` passed.
