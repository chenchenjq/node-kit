import { randomBytes } from "node:crypto";

import { SmsKitError } from "../core/errors.js";
import { normalizeMainlandPhone } from "../core/phone.js";
import type { ChallengeId, TenantId } from "../core/types.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { OtpHasher, PhoneNumberProtector } from "../ports/security.js";
import type { Challenge, SmsStore, SmsTransaction } from "../ports/store.js";
import { OtpGenerator } from "../security/otp-generator.js";
import { SendService } from "./send-service.js";
import { enforcePhoneSendPolicy } from "./send-policy.js";

export type IssueChallengeInput = Readonly<{
  tenantId: TenantId;
  subjectId: string;
  action: "password.change" | "step.up";
  phone: string;
  ipAddress?: string;
  idempotencyKey: string;
}>;

export type VerifyChallengeInput = Readonly<{
  tenantId: TenantId;
  challengeId: ChallengeId;
  code: string;
}>;

export type IssueChallengeResult = Readonly<{ id: ChallengeId; expiresAt: Date }>;
export type VerifyChallengeResult = Readonly<{ proof: string; proofExpiresAt: Date }>;

export type ChallengeServiceDependencies = Readonly<{
  store: Pick<SmsStore, "transaction" | "challenges" | "rateLimits" | "policy">;
  sendService: Pick<SendService, "sendOtpNow">;
  phoneProtector: Pick<PhoneNumberProtector, "protect">;
  hasher: OtpHasher;
  clock: Clock;
  ids: Pick<IdGenerator, "next">;
  otpGenerator?: Pick<OtpGenerator, "generate">;
}>;

type ChallengePurpose = Readonly<{ challenge: "password_change" | "step_up"; send: "auth.password_change" | "auth.step_up" }>;

function requireTrustedTenant(tenantId: TenantId): void {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) throw new SmsKitError("PERMISSION_DENIED", "trusted tenant is required");
}

function purposeFor(action: IssueChallengeInput["action"]): ChallengePurpose {
  if (action === "password.change") return { challenge: "password_change", send: "auth.password_change" };
  if (action === "step.up") return { challenge: "step_up", send: "auth.step_up" };
  throw new SmsKitError("CONFIG_INVALID", "challenge action is invalid");
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new SmsKitError("CONFIG_INVALID", `${field} is required`);
}

function terminalError(challenge: Challenge): SmsKitError | undefined {
  if (challenge.terminalErrorCode === "ACCEPTANCE_UNKNOWN") {
    return new SmsKitError("ACCEPTANCE_UNKNOWN", "provider acceptance is unknown; request a fresh challenge");
  }
  return challenge.terminalErrorCode === undefined ? undefined : new SmsKitError(challenge.terminalErrorCode, "challenge delivery did not complete");
}

function proofBinding(tenantId: TenantId, subjectId: string, action: string, proof: string): string {
  return `${tenantId}\u0000${subjectId}\u0000${action}\u0000${proof}`;
}

/** Issues one direct-delivery OTP challenge and verifies it under a transaction-scoped row lock. */
export class ChallengeService {
  private readonly otpGenerator: Pick<OtpGenerator, "generate">;

  constructor(private readonly dependencies: ChallengeServiceDependencies) {
    this.otpGenerator = dependencies.otpGenerator ?? new OtpGenerator();
  }

  async issue(input: IssueChallengeInput): Promise<IssueChallengeResult> {
    requireTrustedTenant(input.tenantId);
    requireNonEmpty(input.subjectId, "subject");
    requireNonEmpty(input.idempotencyKey, "idempotency key");
    const purpose = purposeFor(input.action);
    const id = this.dependencies.ids.next() as ChallengeId;
    const phone = normalizeMainlandPhone(input.phone);
    // The ciphertext is deliberately discarded: challenges retain only a keyed phone lookup hash.
    const protectedPhone = await this.dependencies.phoneProtector.protect(phone, {
      envelopeVersion: 1, purpose: "phone", tenantId: input.tenantId, recordId: id as never, fieldName: "phone_ciphertext",
    });
    const created = await this.dependencies.store.transaction(async (tx) => {
      const existing = await this.dependencies.store.challenges.getByIdempotency({ tenantId: input.tenantId, idempotencyKey: input.idempotencyKey }, tx);
      if (existing !== undefined) return { challenge: existing, created: false, code: undefined as string | undefined, sendPurpose: purpose.send };
      const policy = await this.dependencies.store.policy.get(tx);
      if (policy.circuitOpen) throw new SmsKitError("CIRCUIT_OPEN", "sending circuit is open");
      const now = this.dependencies.clock.now();
      await this.enforceIssuePolicy({ input, purpose: purpose.send, phoneHash: protectedPhone.lookupHash, now, tx });
      const code = this.otpGenerator.generate(policy.otpLength);
      const challenge = await this.dependencies.store.challenges.create({
        id, tenantId: input.tenantId, idempotencyKey: input.idempotencyKey, subjectId: input.subjectId, action: input.action,
        purpose: purpose.challenge, policyVersion: policy.version, otpLength: policy.otpLength, otpTtlSeconds: policy.otpTtlSeconds, proofTtlSeconds: policy.proofTtlSeconds, phoneHash: protectedPhone.lookupHash,
        codeHash: await this.dependencies.hasher.hash(code), maxAttempts: policy.otpMaxAttempts,
        expiresAt: new Date(now.getTime() + policy.otpTtlSeconds * 1_000),
      }, tx);
      return { challenge, created: true, code, sendPurpose: purpose.send };
    });
    const priorError = terminalError(created.challenge);
    if (priorError !== undefined) throw priorError;
    if (!created.created || created.code === undefined) return { id: created.challenge.id, expiresAt: created.challenge.expiresAt };

    try {
      await this.dependencies.sendService.sendOtpNow({
        tenantId: input.tenantId, templateKey: created.sendPurpose, phone: input.phone, variables: { code: created.code },
        purpose: created.sendPurpose, idempotencyKey: `challenge:${created.challenge.id}`,
      });
    } catch (error) {
      const terminalErrorCode = error instanceof SmsKitError && error.code === "ACCEPTANCE_UNKNOWN" ? "ACCEPTANCE_UNKNOWN" : "PROVIDER_REJECTED";
      await this.dependencies.store.transaction((tx) => this.dependencies.store.challenges.invalidate({
        tenantId: input.tenantId, id: created.challenge.id, invalidatedAt: this.dependencies.clock.now(), terminalErrorCode,
      }, tx));
      if (terminalErrorCode === "ACCEPTANCE_UNKNOWN") {
        throw new SmsKitError("ACCEPTANCE_UNKNOWN", "provider acceptance is unknown; request a fresh challenge");
      }
      if (error instanceof SmsKitError) throw error;
      throw new SmsKitError("PROVIDER_REJECTED", "provider rejected the SMS");
    }
    return { id: created.challenge.id, expiresAt: created.challenge.expiresAt };
  }

  async verify(input: VerifyChallengeInput): Promise<VerifyChallengeResult> {
    requireTrustedTenant(input.tenantId);
    requireNonEmpty(input.code, "code");
    const result = await this.dependencies.store.transaction(async (tx) => {
      const challenge = await this.dependencies.store.challenges.getForUpdate({ tenantId: input.tenantId, id: input.challengeId }, tx);
      if (challenge === undefined || challenge.invalidatedAt !== undefined || challenge.verifiedAt !== undefined) return { kind: "invalid" as const };
      const now = this.dependencies.clock.now();
      if (challenge.expiresAt <= now) return { kind: "expired" as const };
      if (challenge.attemptCount >= challenge.maxAttempts) return { kind: "attempts" as const };
      if (!await this.dependencies.hasher.verify(input.code, challenge.codeHash)) {
        await this.dependencies.store.challenges.incrementAttempts({ tenantId: input.tenantId, id: input.challengeId }, tx);
        return { kind: "wrong" as const };
      }
      const proof = randomBytes(32).toString("base64url");
      const proofExpiresAt = new Date(now.getTime() + challenge.proofTtlSeconds * 1_000);
      await this.dependencies.store.challenges.verify({
        tenantId: input.tenantId, id: input.challengeId, verifiedAt: now, proofHash: await this.dependencies.hasher.hash(proofBinding(input.tenantId, challenge.subjectId, challenge.action, proof)), proofExpiresAt,
      }, tx);
      return { kind: "verified" as const, proof, proofExpiresAt };
    });
    if (result.kind === "verified") return { proof: result.proof, proofExpiresAt: result.proofExpiresAt };
    if (result.kind === "expired") throw new SmsKitError("CHALLENGE_EXPIRED", "challenge has expired");
    if (result.kind === "attempts") throw new SmsKitError("CHALLENGE_ATTEMPTS_EXCEEDED", "challenge attempts are exhausted");
    throw new SmsKitError("PROOF_INVALID", "challenge verification is invalid");
  }

  private async enforceIssuePolicy(input: Readonly<{
    input: IssueChallengeInput;
    purpose: ChallengePurpose["send"];
    phoneHash: string;
    now: Date;
    tx: SmsTransaction;
  }>): Promise<void> {
    const policy = await this.dependencies.store.policy.get(input.tx);
    await enforcePhoneSendPolicy({
      policy, rateLimits: this.dependencies.store.rateLimits, tenantId: input.input.tenantId, phoneHash: input.phoneHash,
      purpose: `challenge:${input.purpose}`, now: input.now, tx: input.tx,
    });
    const windowStart = new Date(Math.floor(input.now.getTime() / (policy.ipWindowSeconds * 1_000)) * policy.ipWindowSeconds * 1_000);
    const expiresAt = new Date(windowStart.getTime() + policy.ipWindowSeconds * 1_000);
    const tenantScope = `challenge:tenant:${input.purpose}`;
    await this.dependencies.store.rateLimits.lock({ tenantId: input.input.tenantId, scopeHash: tenantScope }, input.tx);
    if (await this.dependencies.store.rateLimits.increment({ tenantId: input.input.tenantId, scope: "global", scopeHash: tenantScope, windowStart, windowSeconds: policy.ipWindowSeconds, expiresAt }, input.tx) > policy.ipWindowLimit) {
      throw new SmsKitError("RATE_LIMITED", "tenant challenge limit is exceeded");
    }
    if (input.input.ipAddress !== undefined) {
      const ipScope = await this.dependencies.hasher.hash(`challenge:ip:${input.purpose}:${input.input.ipAddress}`);
      if (await this.dependencies.store.rateLimits.increment({ tenantId: input.input.tenantId, scope: "ip_purpose", scopeHash: ipScope, windowStart, windowSeconds: policy.ipWindowSeconds, expiresAt }, input.tx) > policy.ipWindowLimit) {
        throw new SmsKitError("RATE_LIMITED", "IP challenge limit is exceeded");
      }
    }
  }
}
