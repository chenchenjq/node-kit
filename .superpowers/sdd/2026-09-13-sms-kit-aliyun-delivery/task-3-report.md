# Task 3 Report: configuration and checksum-bound resource sync

## Delivered

- Added configuration, policy, and resource-sync application services plus deterministic canonical SHA-256 checksums.
- Configuration saves require `config.write`; a changed secret reference is saved disabled and `untested`. Connection tests resolve references only ephemerally, persist only an aggregate resource count, and never return resolved values.
- Policy reads/writes use `config.read`/`config.write`, validate all requested OTP, proof, phone/IP, budget, and circuit constraints, and never touch provider configuration.
- Resource discovery reads all provider and local pages before writing a preview. Template imports are explicit selections with a validated stable key, purpose, and local/discovered signature key. A provider failure cannot persist a partial preview.
- Commits run the repository import and audit write in one transaction, fence expiry with the injected clock, require persisted candidate IDs/checksums, and reject non-approved cloud resources before any import. Existing repository upserts retain local template keys, purposes, and enablement.

## TDD and verification

- RED: the requested service tests initially failed because the application modules were absent.
- GREEN: `npm test --workspace sms-kit -- test/unit/application/config-service.test.ts test/unit/application/policy-service.test.ts` — 4 passing tests.
- `npm run test:integration --workspace sms-kit -- resource-sync.test.ts` — 4 passing tests, including PostgreSQL preview/commit, audit, checksum/expiry fence, and rejected-cloud-resource coverage.
- `npm run test:integration --workspace sms-kit -- config-resource.test.ts` — 5 passing tests.
- `npm run typecheck --workspace sms-kit` and `git diff --check` passed.

## Review fix round 1

- Global configuration, verification-policy, and resource-sync preview/commit audits now use the system tenant `__system__`, while retaining the trusted actor ID. Policy updates and persisted sync previews write their audit record in the same transaction as their state change.
- Complete discovery emits checksum-bound `unavailable` candidates for locally imported signatures and templates that are absent from a complete provider snapshot. Applying one marks the local resource `unavailable` and disables it, preventing use of stale cloud approval.
- Connection-test resolver and provider failures are reduced to fixed `SmsKitError` values and audit only that stable code; arbitrary source messages and resolved values never propagate.
- RED: global-audit, safe-error, and removed-resource tests failed against the prior implementation. GREEN: focused application unit tests passed (6 tests), typecheck passed, and the resource-sync PostgreSQL integration suite was rerun.

## Review fix round 2

- Retiring a signature now atomically marks every dependent local template unavailable and disabled, including templates that remain in a provider snapshot but were not selected for refresh. The PostgreSQL resource-sync regression covers this parent-resource retirement path.

## Review fix round 3

- Template selections now require a locally or currently discovered signature that is enabled and cloud-approved. The commit transaction independently verifies this immediately before importing a template, preventing a selected template from bypassing an unavailable, unapproved, or disabled signature.

## Review fix round 4

- Replaced preview's union of remote approval and stale local approval with the effective signature state after synchronization: the signature must be in the current complete provider snapshot, its current cloud status must be approved, and existing local enablement is preserved (new signatures default to enabled).
- Preview and PostgreSQL commit now share `isUsableSignature` and the cloud-approval predicate in `core/resource-usability.ts`, with the projection/commit contract documented beside the helper. Missing signatures are retiring; current cloud approval cannot override a local disable.
- RED: `npm run test:integration --workspace sms-kit -- resource-sync.test.ts` produced 3 expected assertion failures because service preview incorrectly resolved for an absent signature, a locally disabled approved signature, and a currently rejected signature with stale local approval (8 other tests passed).
- GREEN: `npm run test:integration --workspace sms-kit -- resource-sync.test.ts config-resource.test.ts` passed all 16 tests. The service regressions assert `CONFIG_INVALID` and unchanged persisted batch counts; the positive path previews and commits a template with both a new and an existing currently discovered usable signature.
- `npm run typecheck --workspace sms-kit`, the focused configuration/policy application unit tests (6 tests), and `git diff --check` passed.
