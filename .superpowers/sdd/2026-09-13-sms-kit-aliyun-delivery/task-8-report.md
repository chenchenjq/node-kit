# Task 8 completion report

Implemented guarded Aliyun live checks for the `sms-kit` package.

- Added a default-skipped, one-message integration suite that requires explicit non-production and send acknowledgements, test-only credential references, an approved test signature and notification template, and an allowlisted recipient. It makes at most one provider send per process and logs only masked recipient/template identifiers.
- Added a separately opt-in read-only connection suite that checks signature/template listing without sending.
- Added unit coverage for missing allowlists, opt-in separation, test resource names, and recipient allowlisting; documented setup, credential revocation, and the real-message behavior.
- Added `test:live` and `test:live:connection` scripts; neither is invoked by the default test script.

Verification passed:

```text
npm test --workspace sms-kit                 96 passed, 2 live suites skipped
npm run typecheck --workspace sms-kit         passed
npm run build --workspace sms-kit             passed
npm run test:live --workspace sms-kit         guard tests passed; live suites skipped
npm run test:live:connection --workspace sms-kit  live suite skipped
```

No live environment was enabled, no provider credentials were read, and no SMS was sent.

## Fix round 1

Updated `test` and `test:unit` to exclude `test/live/**` unconditionally. A package-metadata regression test now asserts those defaults exclude live suites and that only the explicit live scripts select them.

Verification passed with live opt-in flags set but no credentials configured: default `test` passed 91 tests and `test:unit` passed 89 tests, with neither discovering live suites. With live flags unset, `test:live` passed its guard tests and skipped both provider suites; `test:live:connection` skipped its provider suite. Typecheck passed.
