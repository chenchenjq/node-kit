# sms-kit

Private Node.js SMS toolkit with an Alibaba Cloud (Aliyun) provider. The package's default `npm test --workspace sms-kit` does not contact Aliyun. Live tests use separate scripts and are skipped unless explicitly opted in.

## Aliyun live checks

Use a restricted test account, an approved signature whose name contains `测试` or `test`, an approved notification template whose name contains the same marker, and a test recipient you control. The message scenario sends one real SMS through Aliyun; Aliyun does not provide a no-delivery mode for `SendSms`. The checks do not change provider configuration or delete resources.

Previously exposed Aliyun credentials must be revoked and replaced before testing. Never put AccessKey values in this repository, a committed `.npmrc`, test source, command arguments, logs, or this file. Supply them only through your runtime secret manager/environment. Live credential references must use `env://NAME`, and the referenced variable name must include `TEST`; use credentials scoped to a non-production account.

For the read-only connection check, provide `SMS_KIT_LIVE_NON_PRODUCTION=1`, `SMS_KIT_LIVE_CONNECTION_TEST=1`, and both credential-reference values below. It calls Aliyun's signature and template listing APIs and never sends a message:

```sh
npm run test:live:connection --workspace sms-kit
```

For the one-message scenario, also set every value in this table. It validates the signature and notification template from Aliyun before sending, and rejects a recipient not in the explicit allowlist.

| Variable | Required value |
| --- | --- |
| `SMS_KIT_LIVE_TEST` | `1` to enable the send suite |
| `SMS_KIT_LIVE_NON_PRODUCTION` | `1` to attest that credentials and resources belong to a non-production test account |
| `SMS_KIT_LIVE_ALLOW_SEND` | `1` to explicitly authorize the single SMS |
| `SMS_KIT_LIVE_ACCESS_KEY_ID_REF` | An environment reference such as `env://SMS_KIT_TEST_ACCESS_KEY_ID` |
| `SMS_KIT_LIVE_ACCESS_KEY_SECRET_REF` | An environment reference such as `env://SMS_KIT_TEST_ACCESS_KEY_SECRET` |
| `SMS_KIT_TEST_ACCESS_KEY_ID` | AccessKey ID supplied at runtime; do not commit it |
| `SMS_KIT_TEST_ACCESS_KEY_SECRET` | AccessKey Secret supplied at runtime; do not commit it |
| `SMS_KIT_LIVE_PHONE` | Mainland China test recipient in your control |
| `SMS_KIT_LIVE_PHONE_ALLOWLIST` | Comma- or whitespace-separated recipients; must include the test recipient exactly |
| `SMS_KIT_LIVE_SIGN_NAME` | Approved test signature name containing `test` or `测试` |
| `SMS_KIT_LIVE_TEMPLATE_CODE` | Code of the approved test notification template |
| `SMS_KIT_LIVE_TEMPLATE_PARAMS` | JSON object of string values matching the template variables |

Run the one-message scenario with:

```sh
npm run test:live --workspace sms-kit
```

The scenario performs read-only connection/resource checks first, then sends at most one message in the test process. Its output includes only a masked recipient and masked template code. Keep all test-only flags unset for normal development and CI runs.

The send scenario requires Docker and creates a disposable PostgreSQL 17 test database. It exercises configuration, checksummed resource import, encrypted notification enqueue, worker dispatch, budget reservation, Attempt persistence, audit and daily statistics through the normal services. The database and ephemeral encryption keys are discarded afterward. Acceptance also schedules the normal reconciliation job; this test does not wait for final delivery.

Health snapshots accept an injected `clock`. By default, pending jobs older than five minutes, waiting messages with no fresh callback for one hour, unavailable resources, and a daily budget with at most 10% remaining degrade readiness. The backlog and callback windows can be set with `backlogStaleMs` and `receiptStaleMs`.
