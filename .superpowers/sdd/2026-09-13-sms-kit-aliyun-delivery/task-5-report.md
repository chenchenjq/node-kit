# Task 5 report

- Recovery locks each expired send job before a separate fresh marker check; a marker cannot be orphaned between selection and lease release.
- Workers acquire one job at a time and renew/fence before marking and before provider dispatch; known rejection completion locks job, message, and attempt before changing state.
- PostgreSQL integration coverage includes recovery/marker interleaving, stale lease handling, late same-token results, failed reschedule budget release, and continuation of the remaining batch.
- Queued recovery selects attempts only from jobs locked by that recovery transaction; a completion-held job is skipped without taking its attempt lock. Direct-attempt recovery remains independent.

Evidence (2026-09-14):

- `send-worker.test.ts dispatch-recovery.test.ts`: 11 passed
- `message-job.test.ts`: 10 passed
- package tests: 84 passed; typecheck and build passed
