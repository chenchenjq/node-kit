import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { ChallengeService } from "../../src/application/challenge-service.js";
import { ProofService } from "../../src/application/proof-service.js";
import { SendService } from "../../src/application/send-service.js";
import {
  createBetterAuthPasswordResetPreRouteGuard,
  createBetterAuthSmsAdapter,
  type BetterAuthCallbackContext,
  type BetterAuthOtpIssuance,
  type BetterAuthSmsAdapterOptions,
} from "../../src/better-auth/index.js";
import type { TenantId } from "../../src/core/types.js";
import { createResourceSyncCandidate, type SmsTransaction } from "../../src/ports/store.js";
import { migrateSmsKit } from "../../src/postgres/migrator.js";
import { withPgProofTransaction } from "../../src/postgres/proof-transaction.js";
import { PgSmsStore } from "../../src/postgres/store.js";
import { HmacHasher } from "../../src/security/hmac-hasher.js";
import { startPostgres } from "../integration/postgres/helpers.js";
import { commitResourceFixturePreview } from "../integration/postgres/resource-fixtures.js";

const tenantId = "tenant-auth-flow" as TenantId;
const otpCode = "654321";
const knownPhone = "+8613800138000";
const templateByCode = new Map([
  ["SMS_AUTH_LOGIN", { templateKey: "auth.login_otp", purpose: "better-auth:login" }],
  ["SMS_AUTH_RESET", { templateKey: "auth.password_reset", purpose: "better-auth:passwordReset" }],
  ["SMS_AUTH_CHANGE", { templateKey: "auth.password_change", purpose: "auth.password_change" }],
  ["SMS_AUTH_STEP_UP", { templateKey: "auth.step_up", purpose: "auth.step_up" }],
]);

class QueuedScheduler {
  private readonly tasks: Array<() => Promise<void>> = [];

  schedule(task: () => Promise<void>, _context: BetterAuthCallbackContext): void {
    this.tasks.push(task);
  }

  async drain(): Promise<void> {
    for (const task of this.tasks.splice(0)) await task();
  }
}

export type BetterAuthTestHost = Readonly<{
  fakeProvider: Readonly<{ calls: { send: Array<{ templateKey: string; purpose: string }> } }>;
  createOtpIssuance(): BetterAuthOtpIssuance;
  advanceTime(milliseconds: number): void;
  requestLoginOtp(phoneNumber: string, issuance?: BetterAuthOtpIssuance): Promise<void>;
  requestPasswordResetOtp(phoneNumber: string, issuance?: BetterAuthOtpIssuance): Promise<void>;
  authDeliveryCounts(purpose: "better-auth:login" | "better-auth:passwordReset"): Promise<Readonly<{ messages: number; attempts: number; reservations: number }>>;
  storedAuthData(): Promise<readonly Record<string, unknown>[]>;
  issueAndVerifyPasswordChallenge(): Promise<string>;
  changePassword(userId: string, proof: string, consumptionKey: string): Promise<number>;
  passwordVersion(userId: string): Promise<number | undefined>;
  issueAndVerifyStepUpChallenge(): Promise<string>;
  consumeProof(input: Readonly<{ subjectId: string; proof: string; action: string; consumptionKey: string }>): Promise<{ consumed: true; replay: boolean }>;
  clearProviderCalls(): void;
  stop(): Promise<void>;
}>;

async function seedResources(store: PgSmsStore): Promise<void> {
  const signatureKey = "auth-flow-signature";
  const signature = createResourceSyncCandidate({
    id: randomUUID(), externalKey: signatureKey, changeType: "new", checksum: "auth-flow-signature-v1", resourceType: "signature",
    snapshot: { kind: "signature", externalName: "Auth Flow", externalStatus: "approved", externalType: "text" },
  });
  const templates = [
    ["auth.login_otp", "better-auth:login", "SMS_AUTH_LOGIN"],
    ["auth.password_reset", "better-auth:passwordReset", "SMS_AUTH_RESET"],
    ["auth.password_change", "auth.password_change", "SMS_AUTH_CHANGE"],
    ["auth.step_up", "auth.step_up", "SMS_AUTH_STEP_UP"],
  ].map(([templateKey, purpose, externalCode]) => createResourceSyncCandidate({
    id: randomUUID(), externalKey: `auth-flow:${templateKey}`, changeType: "new", checksum: `auth-flow:${templateKey}:v1`, resourceType: "template",
    signatureExternalKey: signatureKey, templateKey, purpose,
    snapshot: { kind: "template", externalCode, externalName: templateKey, externalStatus: "approved", templateType: "verification", variableNames: ["code"] },
  }));
  const preview = await store.resources.createSyncPreview({
    id: randomUUID(), actorId: "auth-flow-fixture", expiresAt: new Date("2030-01-01T00:00:00.000Z"), resources: [signature, ...templates],
  });
  await commitResourceFixturePreview(store, preview);
}

async function configureProvider(store: PgSmsStore): Promise<void> {
  const config = await store.config.update({
    provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://TEST_ID", accessKeySecretRef: "env://TEST_SECRET",
    receiptCallbackTokenRef: "env://TEST_RECEIPT", enabled: true, expectedVersion: 0,
  });
  await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date("2026-09-14T00:00:00.000Z"), expectedVersion: config.version });
}

/** A no-network host composition used as executable documentation for authentication integration. */
export async function createBetterAuthTestHost(): Promise<BetterAuthTestHost> {
  const postgres = await startPostgres();
  const pool = postgres.pool;
  const store = new PgSmsStore(pool);
  await migrateSmsKit(pool);
  await seedResources(store);
  await configureProvider(store);
  await pool.query("create table auth_flow_user (id text primary key, phone_number text not null unique, password_version integer not null)");
  await pool.query("create table auth_flow_password_change_outcome (consumption_key text primary key, user_id text not null, password_version integer not null)");
  await pool.query("create table auth_flow_otp_issuance (id text primary key, tenant_id text not null, phone_number text not null, purpose text not null, expires_at timestamptz not null)");
  await pool.query("insert into auth_flow_user (id, phone_number, password_version) values ($1, $2, 1)", ["user-1", knownPhone]);

  const hasher = new HmacHasher(Buffer.alloc(32, 41));
  let now = new Date("2026-09-14T00:00:00.000Z");
  const clock = { now: () => new Date(now) };
  const fakeProvider = { calls: { send: [] as Array<{ templateKey: string; purpose: string }> } };
  const phoneProtector = {
    protect: async (phone: string) => ({
      ciphertext: "fixture-phone", keyId: "fixture-phone-key", lookupHash: await hasher.hash(`fixture-phone:${phone}`),
      last4: phone.slice(-4), masked: "***0000",
    }),
  };
  const sendService = new SendService({
    store,
    provider: {
      send: async (input: { templateCode: string }) => {
        const call = templateByCode.get(input.templateCode);
        if (call === undefined) throw new Error("fixture template mapping is missing");
        fakeProvider.calls.send.push(call);
        return { kind: "accepted" as const, bizId: `fixture-${fakeProvider.calls.send.length}`, requestId: "fixture-request" };
      },
    } as never,
    phoneProtector: phoneProtector as never,
    payloadProtector: { seal: async () => ({ ciphertext: "fixture-params", keyId: "fixture-params-key" }) } as never,
    clock,
    ids: { next: () => randomUUID(), messageId: () => randomUUID() as never },
    events: { emit: async () => undefined },
    providerTimeoutMs: 1_000,
  });
  const challengeService = new ChallengeService({
    store,
    sendService,
    phoneProtector: phoneProtector as never,
    hasher,
    clock,
    ids: { next: () => randomUUID() },
    otpGenerator: { generate: () => otpCode },
  });
  const proofService = new ProofService({ store, hasher, clock });
  const scheduler = new QueuedScheduler();
  const otpIssuanceContext = new AsyncLocalStorage<BetterAuthOtpIssuance>();
  const isExistingPhone = async (_tenantId: TenantId, phone: string): Promise<boolean> =>
    (await pool.query("select 1 from auth_flow_user where phone_number = $1", [phone])).rowCount === 1;
  const adapterOptions: BetterAuthSmsAdapterOptions = {
    sendService,
    isExistingPhone,
    resolveTenant: async () => tenantId,
    resolveTrustedIp: async () => "203.0.113.42",
    resolveOtpIssuance: async ({ tenantId: trustedTenantId, phone, purpose }) => {
      const issuance = otpIssuanceContext.getStore();
      if (issuance === undefined) throw new Error("trusted OTP issuance context is missing");
      const persisted = await pool.query<{ id: string; expires_at: Date }>(
        `select id, expires_at from auth_flow_otp_issuance
          where id = $1 and tenant_id = $2 and phone_number = $3 and purpose = $4`,
        [issuance.id, trustedTenantId, phone, purpose],
      );
      const exact = persisted.rows[0];
      if (exact === undefined) throw new Error("trusted OTP issuance does not match the callback");
      return { id: exact.id, expiresAt: exact.expires_at };
    },
    scheduler,
    transaction: async <T>(work: (tx: SmsTransaction) => Promise<T>) => store.transaction(work),
    rateLimits: store.rateLimits,
    policy: store.policy,
    hasher,
    clock,
    sleeper: { sleep: async () => undefined },
    events: { emit: async () => undefined },
  };
  const context = undefined as BetterAuthCallbackContext;
  let challengeSequence = 0;
  let issuanceSequence = 0;

  function createOtpIssuance(): BetterAuthOtpIssuance {
    return { id: `fixture-verification-${++issuanceSequence}`, expiresAt: new Date(now.getTime() + 300_000) };
  }

  async function recordOtpIssuance(phoneNumber: string, purpose: "login" | "passwordReset", issuance: BetterAuthOtpIssuance): Promise<void> {
    await pool.query(
      `insert into auth_flow_otp_issuance (id, tenant_id, phone_number, purpose, expires_at)
       values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
      [issuance.id, tenantId, phoneNumber, purpose, issuance.expiresAt],
    );
  }

  async function issueAndVerify(action: "password.change" | "step.up", idempotencyKey: string): Promise<string> {
    now = new Date(now.getTime() + 61_000);
    const issued = await challengeService.issue({ tenantId, subjectId: "user-1", action, phone: knownPhone, idempotencyKey });
    return (await challengeService.verify({ tenantId, challengeId: issued.id, code: otpCode })).proof;
  }

  return {
    fakeProvider,
    createOtpIssuance,
    advanceTime(milliseconds): void {
      now = new Date(now.getTime() + milliseconds);
    },
    async requestLoginOtp(phoneNumber, issuance = createOtpIssuance()): Promise<void> {
      const callbacks = createBetterAuthSmsAdapter(adapterOptions);
      await recordOtpIssuance(phoneNumber, "login", issuance);
      await otpIssuanceContext.run(issuance, () => callbacks.sendOTP({ phoneNumber, code: otpCode }, context));
      await scheduler.drain();
    },
    async requestPasswordResetOtp(phoneNumber, issuance = createOtpIssuance()): Promise<void> {
      const callbacks = createBetterAuthSmsAdapter(adapterOptions);
      const resetGuard = createBetterAuthPasswordResetPreRouteGuard(adapterOptions);
      await recordOtpIssuance(phoneNumber, "passwordReset", issuance);
      await otpIssuanceContext.run(issuance, () => resetGuard.run({
          phoneNumber,
          context,
          next: async () => {
            if (await isExistingPhone(tenantId, phoneNumber)) await callbacks.sendPasswordResetOTP?.({ phoneNumber, code: otpCode }, context);
            return undefined;
          },
        }));
      await scheduler.drain();
    },
    async authDeliveryCounts(purpose): Promise<Readonly<{ messages: number; attempts: number; reservations: number }>> {
      const result = await pool.query<{ messages: number; attempts: number; reservations: number }>(
        `select count(distinct message.id)::integer as messages,
                count(distinct attempt.id)::integer as attempts,
                count(distinct reservation.message_id)::integer as reservations
           from sms_kit.send_message message
           left join sms_kit.send_attempt attempt on attempt.message_id = message.id
           left join sms_kit.send_budget_reservation reservation on reservation.message_id = message.id
          where message.tenant_id = $1 and message.purpose = $2`,
        [tenantId, purpose],
      );
      return result.rows[0] ?? { messages: 0, attempts: 0, reservations: 0 };
    },
    async storedAuthData(): Promise<readonly Record<string, unknown>[]> {
      return (await pool.query<Record<string, unknown>>(
        `select idempotency_key, metadata, phone_ciphertext, render_params_ciphertext
           from sms_kit.send_message where tenant_id = $1 and purpose like 'better-auth:%'`,
        [tenantId],
      )).rows;
    },
    issueAndVerifyPasswordChallenge: () => issueAndVerify("password.change", `user-1:password.change:${++challengeSequence}`),
    async changePassword(userId, proof, consumptionKey): Promise<number> {
      return withPgProofTransaction(pool, proofService, {
        tenantId, proof, subjectId: userId, action: "password.change", consumptionKey,
      }, {
        execute: async (client) => {
          const updated = await client.query<{ password_version: number }>(
            "update auth_flow_user set password_version = password_version + 1 where id = $1 returning password_version",
            [userId],
          );
          if (updated.rows[0] === undefined) throw new Error("password change user is missing");
          await client.query(
            "insert into auth_flow_password_change_outcome (consumption_key, user_id, password_version) values ($1, $2, $3)",
            [consumptionKey, userId, updated.rows[0].password_version],
          );
          return updated.rows[0].password_version;
        },
        replay: async (client) => {
          const existing = await client.query<{ password_version: number }>(
            "select password_version from auth_flow_password_change_outcome where consumption_key = $1",
            [consumptionKey],
          );
          if (existing.rows[0] === undefined) throw new Error("password change result is missing");
          return existing.rows[0].password_version;
        },
      });
    },
    async passwordVersion(userId): Promise<number | undefined> {
      return (await pool.query<{ password_version: number }>("select password_version from auth_flow_user where id = $1", [userId])).rows[0]?.password_version;
    },
    issueAndVerifyStepUpChallenge: () => issueAndVerify("step.up", `user-1:step.up:${++challengeSequence}`),
    consumeProof: ({ subjectId, proof, action, consumptionKey }) => proofService.consume({ tenantId, proof, subjectId, action, consumptionKey }),
    clearProviderCalls(): void {
      fakeProvider.calls.send.splice(0);
    },
    stop: postgres.stop,
  };
}
