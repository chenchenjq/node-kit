# sms-kit Authentication Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add generic high-risk SMS Challenge/proof flows and an optional Better Auth adapter for existing-account passwordless login and password reset without coupling authentication into the sms-kit core.

**Architecture:** Challenge issuance and verification are application services backed by the existing Store, protectors and rate limits. Same-database consumers join an existing `pg` transaction; cross-database consumers use a shared `consumptionKey` for idempotent compensation. Better Auth remains an optional peer and receives only sending callbacks.

**Tech Stack:** TypeScript 7.0.2, Node.js 20+, Better Auth 1.7.4 optional peer, Vitest 5.0.0, PostgreSQL 17.

**Spec:** `doc/prd/001-sms-kit.md`, especially sections 7.6-7.8; Better Auth reference: <https://better-auth.com/docs/plugins/phone-number>

## Global Constraints

- Complete Foundation and Aliyun Delivery plans first.
- Better Auth is optional; core and non-auth subpaths must load without Better Auth installed.
- First release supports existing accounts only; omit `signUpOnVerification` entirely (its current type is an object, not `false`) and create no registration API.
- Better Auth owns login/password-reset OTP verification, users and sessions; sms-kit owns send policy, template mapping, rate limits, redacted records and audit.
- Generic Challenge defaults are six digits, five minutes and three attempts, but every issuance snapshots the validated versioned policy.
- OTPs and proof tokens are never stored plaintext or logged; only keyed hashes are persisted.
- A proof binds `subjectId + action + challengeId`; consumption requires `consumptionKey` and is idempotent only for the same key.
- Challenge, proof, rate-limit and Better Auth send inputs bind a trusted `tenantId`; subject and phone lookup never cross tenants.
- Do not run real SMS tests in this plan; use FakeAliyunApi and deterministic clocks.
- Do not run `npm publish`; do not add the untracked root `AGENTS.md` to commits.

---

## File Map

- `src/application/challenge-service.ts`: issue and verify high-risk Challenges.
- `src/application/proof-service.ts`: same-database and compensating proof consumption.
- `src/security/otp-generator.ts`: cryptographically secure six-digit code generation.
- `src/postgres/proof-transaction.ts`: joins host `pg.PoolClient` transactions.
- `src/better-auth/types.ts`: adapter options derived from the installed Better Auth `phoneNumber()` option types.
- `src/better-auth/adapter.ts`: existing-phone lookup, constant-envelope scheduling and template mapping.
- `src/better-auth/index.ts`: optional public exports.
- `test/contract/better-auth-adapter.test.ts`: runtime adapter behavior without creating auth sessions.
- `test/contract/better-auth-types.test.ts`: compile-time compatibility with the real Better Auth plugin types.
- `docs` changes inside `packages/sms-kit/README.md`: integration examples and security warnings.

---

### Task 1: Issue and verify high-risk Challenges

**Files:**
- Create: `packages/sms-kit/src/security/otp-generator.ts`
- Modify: `packages/sms-kit/src/security/index.ts`
- Create: `packages/sms-kit/src/application/challenge-service.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Test: `packages/sms-kit/test/unit/security/otp-generator.test.ts`
- Test: `packages/sms-kit/test/integration/application/challenge-service.test.ts`

**Interfaces:**
- Consumes: SendService fenced direct OTP path, ChallengeRepository, RateLimitRepository, PolicyStore, OtpHasher, PhoneNumberProtector, Clock, IdGenerator.
- Produces: `OtpGenerator`, `ChallengeService.issue(input)`, `ChallengeService.verify(input)`.

- [ ] **Step 1: Write failing issuance, expiry and attempt-limit tests**

```ts
it("issues a five-minute challenge without storing the code", async () => {
  const issued = await service.issue({
    tenantId: tenantA,
    subjectId: "user-1",
    action: "password.change",
    phone: "13800138000",
    idempotencyKey: "user-1:password.change:1",
  });
  expect(issued.expiresAt).toEqual(new Date("2026-09-13T02:05:00.000Z"));
  expect(JSON.stringify(await loadChallenge(issued.id))).not.toContain("123456");
});

it("invalidates a challenge after three wrong codes", async () => {
  for (let index = 0; index < 3; index += 1) await service.verify({ challengeId, code: "000000" });
  await expect(service.verify({ challengeId, code: "123456" })).rejects.toMatchObject({
    code: "CHALLENGE_ATTEMPTS_EXCEEDED",
  });
});

it("invalidates the stored challenge when direct delivery is rejected", async () => {
  fakeProvider.rejectNext("isv.BUSINESS_LIMIT_CONTROL");
  await expect(service.issue(validIssueInput)).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
  expect(await activeChallengeCount()).toBe(0);
});
```

- [ ] **Step 2: Run Challenge tests and confirm service is missing**

Run: `npm test --workspace sms-kit -- test/unit/security/otp-generator.test.ts && npm run test:integration --workspace sms-kit -- challenge-service.test.ts`

Expected: FAIL because OTP generation and Challenge services are absent.

- [ ] **Step 3: Implement unbiased OTP generation and atomic verification**

```ts
export class OtpGenerator {
  generate(length = 6): string {
    const ceiling = 10 ** length;
    return randomInt(0, ceiling).toString().padStart(length, "0");
  }
}

export type VerifyChallengeResult = {
  proof: string;
  proofExpiresAt: Date;
};
```

`issue()` reads the versioned policy, atomically enforces its phone/purpose/IP/tenant limits before generating a code, snapshots the selected length/TTL/max-attempt values in the Challenge, stores only the keyed hash, then calls fenced `sendOtpNow()` with `auth.password_change` or `auth.step_up`. A rejected send must invalidate the challenge before returning; an acceptance-unknown result must invalidate it and instruct the caller to request a fresh code without automatically resending. The issue idempotency key returns the same terminal outcome and never creates a second challenge. `verify()` must conditionally increment attempts, compare hashes in constant time, set `verified_at`, generate 32 random proof bytes, store only the proof hash, apply the configured proof TTL, and return the plaintext proof once.

Both operations require `tenantId`; challenge lookup predicates include tenant, and the signed/hashed proof binding includes tenant so a proof cannot authorize the same subject/action in another tenant.

- [ ] **Step 4: Verify concurrent attempts, expiry and plaintext absence**

Run: `npm test --workspace sms-kit -- test/unit/security/otp-generator.test.ts && npm run test:integration --workspace sms-kit -- challenge-service.test.ts`

Expected: PASS; concurrent wrong attempts cannot exceed three accepted checks, expired or undeliverable challenges fail, repeat issuance does not send twice, and database/log fixtures contain no OTP or proof token.

- [ ] **Step 5: Commit Challenge issuance and verification**

```bash
git add packages/sms-kit/src/security packages/sms-kit/src/application packages/sms-kit/test
git commit -m "feat: issue and verify high-risk sms challenges"
```

### Task 2: Consume proofs atomically or with idempotent compensation

**Files:**
- Create: `packages/sms-kit/src/application/proof-service.ts`
- Create: `packages/sms-kit/src/postgres/proof-transaction.ts`
- Modify: `packages/sms-kit/src/application/index.ts`
- Modify: `packages/sms-kit/src/postgres/index.ts`
- Test: `packages/sms-kit/test/integration/application/proof-service.test.ts`
- Test: `packages/sms-kit/test/integration/postgres/proof-transaction.test.ts`

**Interfaces:**
- Consumes: ChallengeRepository `consumeProof`, SmsTransaction, `pg.PoolClient`.
- Produces: `ProofService.consume()`, `withPgProofTransaction(pool, input, work)`.

- [ ] **Step 1: Write failing same-key replay and competing-key tests**

```ts
it("returns the same successful consumption for the same operation key", async () => {
  const input = { tenantId: tenantA, proof, subjectId: "user-1", action: "password.change", consumptionKey: "pwd:change:42" };
  expect(await proofService.consume(input)).toMatchObject({ consumed: true, replay: false });
  expect(await proofService.consume(input)).toMatchObject({ consumed: true, replay: true });
});

it("rejects a second operation key for one proof", async () => {
  await proofService.consume({ ...baseInput, consumptionKey: "operation-a" });
  await expect(proofService.consume({ ...baseInput, consumptionKey: "operation-b" }))
    .rejects.toMatchObject({ code: "PROOF_INVALID" });
});

it("serializes concurrent same-key replay", async () => {
  const [first, second] = await Promise.all([
    proofService.consume(baseInput), proofService.consume(baseInput),
  ]);
  expect([first.replay, second.replay].sort()).toEqual([false, true]);
});

it("does not burn a proof when subject or action binding is wrong", async () => {
  await expect(proofService.consume({ ...baseInput, subjectId: "user-2" }))
    .rejects.toMatchObject({ code: "PROOF_INVALID" });
  await expect(proofService.consume(baseInput)).resolves.toMatchObject({ consumed: true, replay: false });
});
```

- [ ] **Step 2: Run proof tests and confirm transaction helpers are missing**

Run: `npm run test:integration --workspace sms-kit -- proof-service.test.ts proof-transaction.test.ts`

Expected: FAIL because proof consumption modes are absent.

- [ ] **Step 3: Implement key-bound consumption and shared pg transactions**

```ts
export async function withPgProofTransaction<T>(
  pool: Pool,
  input: ConsumeProofInput,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const tx = asSmsTransaction(client);
    await proofService.consume(input, tx);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
```

Repository consumption starts a transaction and performs `SELECT id, subject_id, action, verified_at, proof_expires_at, consumed_at, consumed_by_key FROM sms_kit.otp_challenge WHERE tenant_id = $1 AND proof_hash = $2 FOR UPDATE`. Under the row lock, validate subject, action, verification and expiry before writing. A binding mismatch returns `PROOF_INVALID` without changing consumption fields. If unconsumed, set both fields; if already consumed by the same key, return `replay: true`; if consumed by another key, reject. Cross-database documentation must require the downstream operation to use exactly the same `consumptionKey` as its idempotency key. Add a negative integration test proving that changing only `tenantId` fails without consuming the valid tenant's proof.

- [ ] **Step 4: Verify rollback, same-key replay and concurrent consumers**

Run: `npm run test:integration --workspace sms-kit -- proof-service.test.ts proof-transaction.test.ts`

Expected: PASS; a business callback failure rolls back proof consumption in same-database mode, concurrent same-key calls yield one original plus one replay, only one distinct key can succeed, and wrong tenant/subject/action attempts do not consume the proof.

- [ ] **Step 5: Commit proof consumption modes**

```bash
git add packages/sms-kit/src/application packages/sms-kit/src/postgres packages/sms-kit/test
git commit -m "feat: consume sms proofs with transaction safety"
```

### Task 3: Implement the optional Better Auth sending adapter

**Files:**
- Create: `packages/sms-kit/src/better-auth/types.ts`
- Create: `packages/sms-kit/src/better-auth/adapter.ts`
- Modify: `packages/sms-kit/src/better-auth/index.ts`
- Test: `packages/sms-kit/test/contract/better-auth-adapter.test.ts`
- Test: `packages/sms-kit/test/contract/better-auth-types.test.ts`

**Interfaces:**
- Consumes: SendService fenced direct OTP path, tenant-scoped `isExistingPhone`, RateLimitRepository, PolicyStore, `BackgroundTaskScheduler`, Clock, Sleeper, EventSink, and real Better Auth plugin types.
- Produces: `createBetterAuthSmsAdapter(options)` returning `sendOTP` and `sendPasswordResetOTP` callbacks.

- [ ] **Step 1: Write failing existing/unknown-phone and template mapping tests**

```ts
it("maps login and password reset to distinct stable templates", async () => {
  const adapter = createBetterAuthSmsAdapter(options);
  await adapter.sendOTP({ phoneNumber: "+8613800138000", code: "123456" }, context);
  await adapter.sendPasswordResetOTP({ phoneNumber: "+8613800138000", code: "654321" }, context);
  expect(sendService.calls.map((call) => call.templateKey)).toEqual([
    "auth.login_otp", "auth.password_reset",
  ]);
});

it("does not send or reveal an unknown phone", async () => {
  options.isExistingPhone.mockResolvedValue(false);
  await expect(adapter.sendOTP(args, context)).resolves.toBeUndefined();
  expect(sendService.calls).toHaveLength(0);
  expect(eventSink.events[0]).not.toHaveProperty("phoneNumber");
});

it("deduplicates a repeated Better Auth callback without storing the code", async () => {
  await adapter.sendOTP(args, context);
  await adapter.sendOTP(args, context);
  await scheduler.drain();
  expect(sendService.calls).toHaveLength(1);
  expect(JSON.stringify(await loadMessages())).not.toContain(args.code);
});

it("rate limits before account lookup for both known and unknown phones", async () => {
  await adapter.sendOTP(args, context);
  expect(callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup", "schedule"]);
  options.isExistingPhone.mockResolvedValue(false);
  callOrder.length = 0;
  await adapter.sendOTP(args, context);
  expect(callOrder).toEqual(["phone-limit", "ip-limit", "tenant-limit", "account-lookup"]);
  expect(await countBudgetReservations()).toBe(1);
});

it("surfaces scheduler rejection and observes asynchronous failures", async () => {
  scheduler.rejectNext(new Error("scheduler unavailable"));
  await expect(adapter.sendOTP(args, context)).rejects.toMatchObject({ code: "STORAGE_FAILURE" });
  scheduler.failNextTask(new Error("background send failed"));
  await adapter.sendOTP(args, context);
  await scheduler.drain();
  expect(eventSink.events.at(-1)).toMatchObject({ code: "STORAGE_FAILURE" });
});

it("is accepted by the installed Better Auth phone plugin", () => {
  const callbacks = createBetterAuthSmsAdapter(options);
  const plugin = phoneNumber({ ...callbacks, allowedAttempts: 3 });
  expect(plugin).toBeDefined();
});
```

- [ ] **Step 2: Run adapter contract tests and confirm exports are missing**

Run: `npm run test:contract --workspace sms-kit -- better-auth-adapter.test.ts better-auth-types.test.ts`

Expected: FAIL because the Better Auth adapter does not exist.

- [ ] **Step 3: Implement optional callbacks with scheduled provider work**

```ts
import { phoneNumber } from "better-auth/plugins";

type PhoneNumberOptions = Parameters<typeof phoneNumber>[0];
type BetterAuthSendOtp = NonNullable<PhoneNumberOptions["sendOTP"]>;
type BetterAuthSendPasswordResetOtp = NonNullable<PhoneNumberOptions["sendPasswordResetOTP"]>;
type BetterAuthOtpInput = Parameters<BetterAuthSendOtp>[0];
type BetterAuthCallbackContext = Parameters<BetterAuthSendOtp>[1];

export type BetterAuthSmsAdapterOptions = {
  sendService: Pick<SendService, "sendOtpNow">;
  isExistingPhone(tenantId: TenantId, phone: string): Promise<boolean>;
  resolveTenant(context: BetterAuthCallbackContext): Promise<TenantId>;
  resolveTrustedIp(context: BetterAuthCallbackContext): Promise<string | undefined>;
  resolveOtpIssuance(input: { tenantId: TenantId; phone: string; purpose: "login" | "passwordReset"; context: BetterAuthCallbackContext }): Promise<{ id: string; expiresAt: Date }>;
  scheduler: BackgroundTaskScheduler<BetterAuthCallbackContext>;
  templates?: { login?: string; passwordReset?: string };
  minimumResponseMs?: number;
};

export function createBetterAuthSmsAdapter(options: BetterAuthSmsAdapterOptions) {
  return {
    sendOTP: ((input, context) => dispatchKnownPhone("login", input, context)) satisfies BetterAuthSendOtp,
    sendPasswordResetOTP: ((input, context) =>
      dispatchKnownPhone("passwordReset", input, context)) satisfies BetterAuthSendPasswordResetOtp,
  } satisfies Pick<PhoneNumberOptions, "sendOTP" | "sendPasswordResetOTP">;
}
```

Derive callback input/context from installed Better Auth 1.7.4 types; do not maintain a hand-written duplicate. Resolve tenant/IP from trusted server context and normalize/hash the phone, then atomically apply phone, IP and tenant limits before calling tenant-scoped `isExistingPhone`. For a known account, resolve the exact durable Better Auth verification issuance and derive the direct-send idempotency key as `better-auth:v2:<purpose>:<keyed HMAC of tenant + purpose + normalized phone + issuance ID>`; the ID must be stable for retries, unique per new issuance, and unexpired both before scheduling and execution. Never use OTP digits, a latest-by-phone query, client correlation, a time bucket, or a process cache as the identity, and never persist or emit OTP or raw HMAC input. Schedule `sendOtpNow()` only for existing accounts by passing an unstarted `() => Promise<void>` to `scheduler.schedule`; unknown accounts neither reserve budget nor send. Await/handle synchronous scheduler rejection, wrap the task so every asynchronous failure emits a redacted event, and never create an unobserved Promise. Both branches traverse the same deterministic response-envelope helper backed by injected Clock/Sleeper; tests assert call sequence and requested delay, not wall-clock milliseconds. Never accept tenant from callback payload or include existence, tenant, phone, issuance ID or code in external errors/events. README uses `phoneNumber({ sendOTP, sendPasswordResetOTP, allowedAttempts: 3 })` and omits `signUpOnVerification` entirely. This 2026-09-14 review correction supersedes the original code-derived-key prescription; `.superpowers/sdd` execution ledgers and reports remain immutable historical evidence.

- [ ] **Step 4: Verify optional dependency and timing contract**

Run: `npm run test:contract --workspace sms-kit -- better-auth-adapter.test.ts better-auth-types.test.ts && npm run typecheck --workspace sms-kit`

Expected: PASS; the callbacks compile when passed to the real `phoneNumber()` API, limits run before lookup, known phones schedule an unstarted task, unknown phones do not send or reserve budget, scheduler failures are observed, outward results match, and importing `sms-kit/core` succeeds in a fixture install without Better Auth.

- [ ] **Step 5: Commit Better Auth adapter**

```bash
git add packages/sms-kit/src/better-auth packages/sms-kit/test/contract
git commit -m "feat: adapt sms delivery for better auth"
```

### Task 4: Document and verify complete authentication integrations

**Files:**
- Modify: `packages/sms-kit/README.md`
- Create: `packages/sms-kit/test/integration/auth/auth-flows.test.ts`
- Create: `packages/sms-kit/test/fixtures/better-auth-host.ts`

**Interfaces:**
- Consumes: ChallengeService, ProofService, Better Auth adapter, Fake provider and PgSmsStore.
- Produces: executable integration examples for login, password reset, password change and generic step-up verification.

- [ ] **Step 1: Write failing end-to-end simulated auth flows**

```ts
it("sends a Better Auth login code only for an existing account", async () => {
  await host.requestLoginOtp("+8613800138000");
  expect(fakeProvider.calls.send).toHaveLength(1);
  expect(fakeProvider.calls.send[0]!.templateKey).toBe("auth.login_otp");
});

it("requires a consumed proof before password change", async () => {
  const { proof } = await issueAndVerifyPasswordChallenge();
  await withPgProofTransaction(pool, {
    proof, subjectId: "user-1", action: "password.change", consumptionKey: "pwd:42",
  }, (client) => changePassword(client, "user-1", "pwd:42"));
  expect(await passwordVersion("user-1")).toBe(2);
});
```

- [ ] **Step 2: Run auth integration tests and confirm host fixture gaps**

Run: `npm run test:integration --workspace sms-kit -- auth-flows.test.ts`

Expected: FAIL until the fixture wires every service and template mapping.

- [ ] **Step 3: Complete the fixture and README examples**

Document exact Better Auth server configuration, phone fields/migration responsibility, `waitUntil` scheduler injection, existing-account lookup, response envelope, template prerequisites, password-reset mapping, same-database proof transaction and cross-database `consumptionKey` compensation.

```ts
const callbacks = createBetterAuthSmsAdapter({
  sendService,
  resolveTenant: (context) => tenantFromTrustedSession(context),
  resolveTrustedIp: (context) => ipFromTrustedProxy(context),
  isExistingPhone: (tenantId, phone) => users.existsByPhone(tenantId, phone),
  scheduler: { schedule: (task) => waitUntil(task()) },
});
const policy = await policyService.get(systemActor);

phoneNumber({
  sendOTP: callbacks.sendOTP,
  sendPasswordResetOTP: callbacks.sendPasswordResetOTP,
  otpLength: policy.otpLength,
  expiresIn: policy.otpTtlSeconds,
  allowedAttempts: policy.otpMaxAttempts,
});
```

Do not add a `signUpOnVerification` property to this object. In Better Auth 1.7.4 it is an object configuration when enabled, so `false` is not a valid way to disable registration. Document that Better Auth reads these three numeric options when the auth instance is constructed; a host that allows them to change at runtime must rebuild its auth instance through its normal configuration lifecycle, while sms-kit send limits, budget and circuit settings take effect dynamically on each request.

- [ ] **Step 4: Run complete auth security verification**

Run: `npm test --workspace sms-kit -- test/unit/security test/contract/better-auth-adapter.test.ts && npm run test:integration --workspace sms-kit -- auth-flows.test.ts && npm run build --workspace sms-kit`

Expected: PASS; no test logs contain phone/code/proof plaintext and no network SMS is sent.

- [ ] **Step 5: Commit authentication documentation and flows**

```bash
git add packages/sms-kit/README.md packages/sms-kit/test/integration/auth packages/sms-kit/test/fixtures
git commit -m "docs: verify sms authentication integrations"
```

---

## Authentication Security Completion Gate

Run:

```bash
npm test --workspace sms-kit
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
```

Expected: all simulated authentication flows pass; core imports without Better Auth; no live provider invocation occurs. Proceed to Next Admin API only after this gate passes.
