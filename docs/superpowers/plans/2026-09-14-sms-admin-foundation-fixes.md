# sms-kit Admin Foundation Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Task 3 configuration and resource routes execute durable sms-kit application/Port/PostgreSQL behavior with optimistic versions, tenant-fenced idempotency, correct partial updates, and real connection-test counts.

**Architecture:** Add a generic PostgreSQL-backed admin-operation claim/result Port whose `(tenantId, operation, idempotencyKey)` key fences replays and whose request checksum rejects key reuse with different input. Application services wrap global configuration/resource mutations, audit writes, and result-snapshot completion in the same `SmsStore.transaction`; global resources stay global while only the trusted actor tenant scopes the idempotency namespace. Extend the existing resource repository with row-locked update/import primitives and keep the existing sync APIs compatible while activating version/idempotency behavior whenever the Next route supplies those fields.

**Tech Stack:** TypeScript 7, Node.js 20+, PostgreSQL 17, pg, Zod, Vitest, Testcontainers.

**Spec:** `doc/prd/001-sms-kit.md` sections 7.2, 7.3, 7.11, and 11.1; independent review of commit `0961cae`.

## Global Constraints

- Keep Task 1/2 DTO field meanings, strict request validation, route envelopes, authorization, and safe-error behavior unchanged.
- Configuration, signatures, and templates remain system-global; only admin idempotency keys are fenced by trusted `actor.tenantId`.
- Same-key/same-request retries return the first committed snapshot; same-key/different-request retries return `IDEMPOTENCY_CONFLICT`.
- A failed mutation leaves no completed idempotency record; mutation, audit, and result completion share one PostgreSQL transaction.
- Stable template keys cannot change after any `send_message` references the template, including a send racing the rename.
- No result snapshot may contain resolved credentials, full phones, OTPs, or plaintext template parameters.
- Do not alter prior migration files or execute publish commands.
- Migration `0008_signature_active_identity.sql` replaces the historical full
  signature display-identity constraint with an active-row partial unique index;
  unavailable historical signatures therefore do not block a provider recreate.

---

### Task 1: Add the tenant-fenced admin-operation persistence primitive

**Files:**
- Modify: `packages/sms-kit/src/ports/store.ts`
- Create: `packages/sms-kit/src/postgres/migrations/0007_admin_operation.sql`
- Modify: `packages/sms-kit/src/postgres/migrator.ts`
- Create: `packages/sms-kit/src/postgres/repositories/admin-operation-repository.ts`
- Modify: `packages/sms-kit/src/postgres/store.ts`
- Create: `packages/sms-kit/src/application/admin-operation.ts`
- Modify: `packages/sms-kit/test/integration/postgres/migration.test.ts`
- Modify: `packages/sms-kit/test/integration/postgres/config-resource.test.ts`

**Interfaces:**
- Produces `AdminOperationRepository.find/claim/complete`, with `claim` and `complete` requiring `SmsTransaction`.
- Produces `executeAdminOperation` and `findAdminOperationReplay`, which hash canonical JSON request data and decode stored result snapshots.

- [ ] **Step 1: Write failing migration and repository tests**

Add tests that assert schema version 7 and the `admin_operation` table exist. Against `PgSmsStore.adminOperations`, claim a key in tenant A, complete it with `{ kind: "signature", id: "signature-1", version: 2 }`, and assert tenant A replays it, a different request checksum throws `IDEMPOTENCY_CONFLICT`, and tenant B gets a fresh claim for the same operation/key.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run test:integration --workspace sms-kit -- migration.test.ts config-resource.test.ts`

Expected: FAIL because schema version 7, `admin_operation`, and `PgSmsStore.adminOperations` do not exist.

- [ ] **Step 3: Implement the migration, Port, repository, and application helper**

Create a table with `tenant_id`, `operation`, `idempotency_key`, `request_checksum`, nullable `result_snapshot`, timestamps, and primary key `(tenant_id, operation, idempotency_key)`. `claim` uses `INSERT ... ON CONFLICT DO NOTHING`; on conflict it reads the row `FOR UPDATE`, rejects a checksum mismatch, and returns only a completed snapshot. `complete` updates exactly the claimed row/checksum and rejects zero rows. The helper uses `canonicalChecksum(request)` and a caller-provided safe encoder/decoder.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `npm run test:integration --workspace sms-kit -- migration.test.ts config-resource.test.ts`

Expected: PASS with schema version 7 and tenant-separated replay.

---

### Task 2: Implement idempotent partial provider-config writes and exact test counts

**Files:**
- Modify: `packages/sms-kit/src/ports/runtime.ts`
- Modify: `packages/sms-kit/src/application/config-service.ts`
- Modify: `packages/sms-kit/src/postgres/repositories/config-repository.ts`
- Modify: `packages/sms-kit/src/next/handlers/config.ts`
- Modify: `packages/sms-kit/test/unit/application/config-service.test.ts`
- Modify: `packages/sms-kit/test/integration/next/config-routes.test.ts`
- Create: `packages/sms-kit/test/integration/next/config-pg-routes.test.ts`

**Interfaces:**
- Produces `ConfigService.patch(actor, { expectedVersion, idempotencyKey, ...requestFields })` while preserving the existing full-state `save` method.
- Connection summaries use safe metric names `signature` and `template`; the route reads those exact values instead of inventing zeros.

- [ ] **Step 1: Write failing service and real-PG route tests**

Cover omitted `receiptCallbackTokenRef`/`enabled` preserving stored values, explicit false disabling, same-key replay returning the original version without a second audit/update, different payload conflict, stale different-key rejection, and same key from a second tenant not replaying the first tenant. Make the provider return signature count 7 and template count 11 and assert the route returns 7/11.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test --workspace sms-kit -- test/unit/application/config-service.test.ts && npm run test:integration --workspace sms-kit -- config-routes.test.ts config-pg-routes.test.ts`

Expected: FAIL because `patch` and safe split counts do not exist and the route currently requires/defaults omitted fields.

- [ ] **Step 3: Implement the minimal partial/idempotent flow**

`patch` claims the operation before reading mutable state, fills only omitted callback/enabled fields from the locked current config, then calls the existing optimistic `ConfigRepository.update`, appends the system-tenant audit, and completes the safe config snapshot in one transaction. Update config SQL so an unchanged successfully-tested configuration can be explicitly enabled as `ready`, explicit false becomes `disabled`, and changed provider connection inputs reset readiness. Save split provider counts in `lastTestSummary`; the route treats missing split counts after a completed test as storage corruption rather than returning fake zeroes.

- [ ] **Step 4: Re-run focused tests and verify GREEN**

Run: `npm test --workspace sms-kit -- test/unit/application/config-service.test.ts && npm run test:integration --workspace sms-kit -- config-routes.test.ts config-pg-routes.test.ts`

Expected: PASS with one durable write/audit for a replay and exact provider counts.

---

### Task 3: Add the built-in resource administration service and PostgreSQL mutations

**Files:**
- Modify: `packages/sms-kit/src/ports/store.ts`
- Modify: `packages/sms-kit/src/postgres/repositories/resource-repository.ts`
- Create: `packages/sms-kit/src/application/resource-admin-service.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Modify: `packages/sms-kit/src/next/handlers/resources.ts`
- Create: `packages/sms-kit/test/integration/application/resource-admin.test.ts`
- Modify: `packages/sms-kit/test/integration/next/resource-routes.test.ts`

**Interfaces:**
- Produces `ResourceAdminService.listSignatures/listTemplates/updateSignature/importTemplate/updateTemplate`.
- Adds `ResourceRepository.updateSignature/importTemplate/updateTemplate`; all write primitives require an expected version and run inside the application-owned transaction.

- [ ] **Step 1: Write failing real-PG service tests**

Seed approved resources and assert authorization-backed lists, signature update/replay/conflict, unused template rename, used template rename rejection, explicit enable/purpose updates, candidate checksum/expiry/signature-version fences, idempotent import replay, and a second tenant with the same key not replaying tenant A.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test:integration --workspace sms-kit -- resource-admin.test.ts resource-routes.test.ts`

Expected: FAIL because the application service and repository mutations do not exist.

- [ ] **Step 3: Implement row-locked repository writes and service orchestration**

For PATCH, lock the target row, compare `version`, validate cloud/signature usability for enabling, update only supplied fields, and increment once. For a key rename, retain the template row lock while checking `NOT EXISTS (SELECT 1 FROM sms_kit.send_message WHERE template_id = ...)`; this lock is mutually exclusive with the transactional `FOR SHARE` lookup used before message creation. For import, lock the candidate/sync, verify running/unexpired/uncommitted/checksum/template selection, hold a shared signature lock with matching version/usability, insert from the persisted safe snapshot, and mark the candidate committed. The service owns permission checks, input validation, idempotency, system audit, and events.

- [ ] **Step 4: Route the built-in service and verify GREEN**

Make list routes pass the actor and type the dependency as a `Pick<ResourceAdminService<Actor>, ...>`. Run: `npm run test:integration --workspace sms-kit -- resource-admin.test.ts resource-routes.test.ts`

Expected: PASS; no host-authored mutation semantics remain necessary.

---

### Task 4: Preserve and enforce version/idempotency through resource sync routes

**Files:**
- Modify: `packages/sms-kit/src/application/resource-sync-service.ts`
- Modify: `packages/sms-kit/src/next/handlers/resources.ts`
- Modify: `packages/sms-kit/test/integration/application/resource-sync.test.ts`
- Create: `packages/sms-kit/test/integration/next/resource-pg-routes.test.ts`

**Interfaces:**
- Existing direct application calls may omit admin write metadata for backward compatibility.
- When Next supplies both fields, preview and commit use `provider_config.version` as the optimistic fence and the tenant-scoped admin-operation key for replay.

- [ ] **Step 1: Write failing PG sync/route tests**

Assert preview replay returns the original sync ID and does not add a second batch, commit replay returns the original snapshot after the batch is already succeeded, key reuse with changed candidates conflicts, stale config versions reject, and route inputs reach the application layer intact.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test:integration --workspace sms-kit -- resource-sync.test.ts resource-pg-routes.test.ts resource-routes.test.ts`

Expected: FAIL because preview drops both fields and commit does not enforce them.

- [ ] **Step 3: Implement compatible admin metadata handling**

Require version/key as a pair when either is present. Check completed replay before provider reads; after discovery, claim inside the persistence transaction, lock/check config version, persist the preview/audit, and complete the snapshot. Commit claims, locks/checks config version, commits candidates, audits, and completes in one transaction. Keep the old no-metadata behavior for Foundation callers.

- [ ] **Step 4: Verify the full affected matrix**

Run:

```bash
npm test --workspace sms-kit
npm run test:integration --workspace sms-kit
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
```

Expected: all tests pass; declarations build; prior Foundation/Aliyun/Task1/Task2 contracts remain green.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-14-sms-admin-foundation-fixes.md packages/sms-kit/src packages/sms-kit/test
git commit -m "fix: make sms admin writes durable"
```
