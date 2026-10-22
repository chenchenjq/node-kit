import { randomBytes, randomUUID } from "node:crypto";

import { SmsKitError, type SmsErrorCode } from "../core/errors.js";
import { normalizeMainlandPhone } from "../core/phone.js";
import { isCloudApproved } from "../core/resource-usability.js";
import {
  SYSTEM_SCOPE,
  type ChallengeId,
  type MessageId,
} from "../core/types.js";
import { positiveTimeoutMs, type SmsProvider } from "../ports/provider.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { OtpHasher, PhoneNumberProtector } from "../ports/security.js";
import type { VerificationPolicy } from "../ports/policy.js";
import type { SmsStore, SmsTransaction, Template } from "../ports/store.js";
import type {
  SystemAuthAction,
  SystemAuthChallenge,
  SystemAuthRepository,
} from "../ports/system-auth.js";
import { OtpGenerator } from "../security/otp-generator.js";
import { enforcePhoneSendPolicy } from "./send-policy.js";
import { withProviderTimeout } from "../ports/provider-timeout.js";

export type IssueSystemAuthChallengeInput = Readonly<{
  subjectId: string;
  action: SystemAuthAction;
  phone: string;
  ipAddress?: string;
  idempotencyKey: string;
}>;
export type VerifySystemAuthChallengeInput = Readonly<{
  subjectId: string;
  action: SystemAuthAction;
  challengeId: ChallengeId;
  code: string;
}>;
export type IssueSystemAuthChallengeResult = Readonly<{
  id: ChallengeId;
  expiresAt: Date;
}>;
export type VerifySystemAuthChallengeResult = Readonly<{
  proof: string;
  proofExpiresAt: Date;
}>;
export type ConsumeSystemAuthProofInput = Readonly<{
  subjectId: string;
  action: SystemAuthAction;
  proof: string;
  consumptionKey: string;
}>;

export type SystemAuthSmsServiceDependencies = Readonly<{
  store: Pick<
    SmsStore,
    "transaction" | "config" | "resources" | "policy" | "rateLimits" | "audits"
  >;
  repository: SystemAuthRepository;
  provider: SmsProvider;
  phoneProtector: Pick<PhoneNumberProtector, "protect">;
  hasher: OtpHasher;
  clock: Clock;
  ids: Pick<IdGenerator, "next" | "messageId">;
  providerTimeoutMs: number;
  otpGenerator?: Pick<OtpGenerator, "generate">;
}>;

function required(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new SmsKitError("CONFIG_INVALID", `${field} is required`);
}
function purpose(
  action: SystemAuthAction,
): Readonly<{
  challenge: "login_otp" | "password_reset";
  templateKey: string;
}> {
  return action === "login.authenticate"
    ? { challenge: "login_otp", templateKey: "auth.login_otp" }
    : { challenge: "password_reset", templateKey: "auth.password_reset" };
}
function config(input: Awaited<ReturnType<SmsStore["config"]["get"]>>) {
  if (
    input.status === "unconfigured" ||
    input.status !== "ready" ||
    !input.enabled
  )
    throw new SmsKitError(
      "CONFIG_INVALID",
      "provider configuration is not ready",
    );
  return {
    region: input.region,
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    accessKeyId: input.accessKeyIdRef,
    accessKeySecret: input.accessKeySecretRef,
  };
}
function terminal(error: unknown): SmsErrorCode {
  return error instanceof SmsKitError ? error.code : "PROVIDER_REJECTED";
}
function proofBinding(
  subjectId: string,
  action: SystemAuthAction,
  proof: string,
): string {
  return `SYSTEM\u0000${subjectId}\u0000${action}\u0000${proof}`;
}

/** Singleton login/password-reset SMS flow; it never accepts or invents a tenant id. */
export class SystemAuthSmsService {
  private readonly otpGenerator: Pick<OtpGenerator, "generate">;
  constructor(private readonly dependencies: SystemAuthSmsServiceDependencies) {
    this.otpGenerator = dependencies.otpGenerator ?? new OtpGenerator();
  }

  async issue(
    input: IssueSystemAuthChallengeInput,
  ): Promise<IssueSystemAuthChallengeResult> {
    required(input.subjectId, "subject");
    required(input.idempotencyKey, "idempotency key");
    const auth = config(await this.dependencies.store.config.get());
    const timeoutMs = positiveTimeoutMs(this.dependencies.providerTimeoutMs);
    const targetPurpose = purpose(input.action);
    const phone = normalizeMainlandPhone(input.phone);
    const challengeId = this.dependencies.ids.next() as ChallengeId;
    const pendingMessageId = this.dependencies.ids.messageId();
    const phoneProtected = await this.dependencies.phoneProtector.protect(
      phone,
      {
        envelopeVersion: 1,
        purpose: "phone",
        tenantId: null,
        recordId: pendingMessageId,
        fieldName: "phone_ciphertext",
      },
    );
    const prepared = await this.dependencies.store.transaction(async (tx) => {
      await this.dependencies.store.rateLimits.lock(
        {
          ownership: SYSTEM_SCOPE,
          scopeHash: `system-auth:${input.idempotencyKey}`,
        },
        tx,
      );
      const existing =
        await this.dependencies.repository.getChallengeByIdempotency(
          { idempotencyKey: input.idempotencyKey },
          tx,
        );
      if (existing !== undefined)
        return {
          challenge: existing,
          messageId: undefined as MessageId | undefined,
          dispatchToken: undefined as string | undefined,
          code: undefined as string | undefined,
          target: undefined as SendTarget | undefined,
        };
      const policy = await this.dependencies.store.policy.get(tx);
      const now = this.dependencies.clock.now();
      this.assertPolicy(policy);
      await enforcePhoneSendPolicy({
        policy,
        rateLimits: this.dependencies.store.rateLimits,
        ownership: SYSTEM_SCOPE,
        phoneHash: phoneProtected.lookupHash,
        purpose: `system-auth:${targetPurpose.templateKey}`,
        now,
        tx,
      });
      await this.enforceIpLimit(
        policy,
        input,
        targetPurpose.templateKey,
        now,
        tx,
      );
      const target = await this.requireTemplate(targetPurpose.templateKey, tx);
      await this.dependencies.repository.invalidateActiveChallenges(
        {
          subjectId: input.subjectId,
          action: input.action,
          invalidatedAt: now,
        },
        tx,
      );
      const code = this.otpGenerator.generate(policy.otpLength);
      const challenge = await this.dependencies.repository.createChallenge(
        {
          id: challengeId,
          idempotencyKey: input.idempotencyKey,
          subjectId: input.subjectId,
          action: input.action,
          purpose: targetPurpose.challenge,
          policyVersion: policy.version,
          otpLength: policy.otpLength,
          otpTtlSeconds: policy.otpTtlSeconds,
          proofTtlSeconds: policy.proofTtlSeconds,
          phoneHash: phoneProtected.lookupHash,
          codeHash: await this.dependencies.hasher.hash(code),
          maxAttempts: policy.otpMaxAttempts,
          expiresAt: new Date(now.getTime() + policy.otpTtlSeconds * 1_000),
        },
        tx,
      );
      const message = await this.dependencies.repository.createMessage(
        {
          id: pendingMessageId,
          idempotencyKey: `system-auth:${challenge.id}`,
          templateId: target.template.id,
          templateKey: target.template.templateKey,
          templateCode: target.template.externalCode,
          signatureName: target.signatureName,
          purpose: target.template.purpose,
          phoneCiphertext: phoneProtected.ciphertext,
          phoneKeyId: phoneProtected.keyId,
          phoneHash: phoneProtected.lookupHash,
          phoneLast4: phoneProtected.last4,
          phoneMasked: phoneProtected.masked,
          variableNames: target.template.variables.map(
            (variable) => variable.name,
          ),
          submittedAt: now,
        },
        tx,
      );
      await this.dependencies.store.policy.holdBudget(
        { ownership: SYSTEM_SCOPE, messageId: message.id, now },
        tx,
      );
      const dispatchToken = await this.dependencies.repository.startAttempt(
        { messageId: message.id, occurredAt: now },
        tx,
      );
      return { challenge, messageId: message.id, dispatchToken, code, target };
    });
    if (
      prepared.messageId === undefined ||
      prepared.dispatchToken === undefined ||
      prepared.code === undefined ||
      prepared.target === undefined
    ) {
      if (prepared.challenge.deliveryAcceptanceStatus !== "accepted")
        throw new SmsKitError(
          prepared.challenge.terminalErrorCode ?? "ACCEPTANCE_UNKNOWN",
          "system authentication challenge is not deliverable",
        );
      return {
        id: prepared.challenge.id,
        expiresAt: prepared.challenge.expiresAt,
      };
    }
    const { messageId, dispatchToken, code: otpCode, target } = prepared;
    let outcome: Awaited<ReturnType<SmsProvider["send"]>>;
    try {
      outcome = await withProviderTimeout(
        () =>
          this.dependencies.provider.send({
            ...auth,
            phoneNumber: phone,
            signatureName: target.signatureName,
            templateCode: target.template.externalCode,
            templateParams: { code: otpCode },
            outId: messageId,
            timeoutMs,
          }),
        timeoutMs,
      );
    } catch {
      outcome = { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
    }
    const now = this.dependencies.clock.now();
    if (outcome.kind === "accepted") {
      await this.dependencies.store.transaction(async (tx) => {
        await this.dependencies.repository.completeAttempt(
          {
            messageId,
            dispatchToken,
            status: "accepted",
            occurredAt: now,
            providerRequestId: outcome.requestId,
          },
          tx,
        );
        await this.dependencies.repository.markMessageAcceptance(
          {
            id: messageId,
            status: "accepted",
            occurredAt: now,
            providerBizId: outcome.bizId,
            providerRequestId: outcome.requestId,
          },
          tx,
        );
        await this.dependencies.repository.markChallengeDelivery(
          { id: prepared.challenge.id, status: "accepted" },
          tx,
        );
        await this.dependencies.repository.scheduleReconciliation(
          { messageId, availableAt: now }, tx,
        );
        await this.dependencies.store.audits.append({
          id: randomUUID(),
          ...SYSTEM_SCOPE,
          actorId: "system-auth",
          action: "auth.sms.send",
          targetType: "message",
          targetId: messageId,
          result: "succeeded",
          occurredAt: now,
        }, tx);
      });
      return {
        id: prepared.challenge.id,
        expiresAt: prepared.challenge.expiresAt,
      };
    }
    const errorCode: SmsErrorCode =
      outcome.kind === "unknown" ? outcome.code : "PROVIDER_REJECTED";
    await this.dependencies.store.transaction(async (tx) => {
      await this.dependencies.repository.completeAttempt(
        {
          messageId,
          dispatchToken,
          status: outcome.kind === "unknown" ? "unknown" : "rejected",
          occurredAt: now,
          ...(outcome.kind === "rejected" ? { providerCode: outcome.code } : {}),
          ...(outcome.kind === "rejected" && outcome.requestId !== undefined
            ? { providerRequestId: outcome.requestId }
            : {}),
          errorCode,
        },
        tx,
      );
      await this.dependencies.repository.markMessageAcceptance(
        {
          id: messageId,
          status: outcome.kind === "unknown" ? "unknown" : "rejected",
          occurredAt: now,
          ...(outcome.kind === "rejected" && outcome.requestId !== undefined
            ? { providerRequestId: outcome.requestId }
            : {}),
          errorCode,
        },
        tx,
      );
      if (outcome.kind === "rejected") {
        await this.dependencies.store.policy.releaseBudget(
          { ownership: SYSTEM_SCOPE, messageId },
          tx,
        );
      }
      await this.dependencies.repository.markChallengeDelivery(
        {
          id: prepared.challenge.id,
          status: outcome.kind === "unknown" ? "unknown" : "rejected",
          invalidatedAt: now,
          terminalErrorCode: errorCode,
        },
        tx,
      );
      if (outcome.kind === "unknown")
        await this.dependencies.repository.scheduleReconciliation(
          { messageId, availableAt: now }, tx,
        );
      await this.dependencies.store.audits.append({
        id: randomUUID(),
        ...SYSTEM_SCOPE,
        actorId: "system-auth",
        action: "auth.sms.send",
        targetType: "message",
        targetId: messageId,
        result: "failed",
        errorCode,
        occurredAt: now,
      }, tx);
    });
    if (outcome.kind === "unknown")
      throw new SmsKitError(
        "ACCEPTANCE_UNKNOWN",
        "provider acceptance is unknown",
      );
    throw new SmsKitError(
      outcome.retryable ? "PROVIDER_THROTTLED" : "PROVIDER_REJECTED",
      "provider rejected the SMS",
      outcome.retryable,
      undefined,
      outcome.code,
    );
  }

  async verify(
    input: VerifySystemAuthChallengeInput,
  ): Promise<VerifySystemAuthChallengeResult> {
    required(input.subjectId, "subject");
    required(input.code, "code");
    const result = await this.dependencies.store.transaction((tx) => this.verifyWithin(input, tx));
    if (result.kind === "verified") return result;
    if (result.kind === "expired")
      throw new SmsKitError("CHALLENGE_EXPIRED", "challenge has expired");
    if (result.kind === "attempts")
      throw new SmsKitError("CHALLENGE_ATTEMPTS_EXCEEDED", "challenge attempts are exhausted");
    if (result.kind === "delivery")
      throw new SmsKitError(result.code, "challenge delivery did not complete");
    throw new SmsKitError("PROOF_INVALID", "challenge verification is invalid");
  }

  /** Caller owns the transaction. Commit a false result to retain failed-attempt accounting. */
  async verifyAndConsume(
    input: VerifySystemAuthChallengeInput & { consumptionKey: string },
    tx: SmsTransaction,
  ): Promise<boolean> {
    required(input.subjectId, "subject");
    required(input.code, "code");
    required(input.consumptionKey, "consumption key");
    const result = await this.verifyWithin(input, tx);
    if (result.kind !== "verified") return false;
    return (await this.consumeProof({
      subjectId: input.subjectId, action: input.action,
      proof: result.proof, consumptionKey: input.consumptionKey,
    }, tx)) === "consumed";
  }

  private async verifyWithin(input: VerifySystemAuthChallengeInput, tx: SmsTransaction) {
    const current = await this.dependencies.repository.getChallengeForUpdate(
      { id: input.challengeId },
      tx,
    );
    const now = this.dependencies.clock.now();
    if (
      current === undefined ||
      current.subjectId !== input.subjectId ||
      current.action !== input.action ||
      current.invalidatedAt !== undefined ||
      current.verifiedAt !== undefined
    )
      return { kind: "invalid" as const };
    if (current.deliveryAcceptanceStatus !== "accepted")
      return {
        kind: "delivery" as const,
        code: current.terminalErrorCode ?? "ACCEPTANCE_UNKNOWN",
      };
    if (current.expiresAt <= now) return { kind: "expired" as const };
    if (current.attemptCount >= current.maxAttempts)
      return { kind: "attempts" as const };
    if (
      !(await this.dependencies.hasher.verify(input.code, current.codeHash))
    ) {
      await this.dependencies.repository.incrementChallengeAttempts(
        { id: current.id },
        tx,
      );
      return { kind: "wrong" as const };
    }
    const proof = randomBytes(32).toString("base64url");
    const proofExpiresAt = new Date(
      now.getTime() + current.proofTtlSeconds * 1_000,
    );
    await this.dependencies.repository.verifyChallenge(
      {
        id: current.id,
        verifiedAt: now,
        proofHash: await this.dependencies.hasher.hash(
          proofBinding(input.subjectId, input.action, proof),
        ),
        proofExpiresAt,
      },
      tx,
    );
    return { kind: "verified" as const, proof, proofExpiresAt };
  }

  async consumeProof(
    input: ConsumeSystemAuthProofInput,
    tx?: SmsTransaction,
  ): Promise<"consumed" | "replay"> {
    required(input.subjectId, "subject");
    required(input.proof, "proof");
    required(input.consumptionKey, "consumption key");
    const consume = async (transaction: SmsTransaction) =>
      await this.dependencies.repository.consumeProof(
        {
          subjectId: input.subjectId,
          action: input.action,
          proofHash: await this.dependencies.hasher.hash(
            proofBinding(input.subjectId, input.action, input.proof),
          ),
          consumptionKey: input.consumptionKey,
          now: this.dependencies.clock.now(),
        },
        transaction,
      );
    const result =
      tx === undefined
        ? await this.dependencies.store.transaction(consume)
        : await consume(tx);
    if (result === "invalid")
      throw new SmsKitError(
        "PROOF_INVALID",
        "system authentication proof is invalid",
      );
    return result;
  }

  private assertPolicy(policy: VerificationPolicy): void {
    if (policy.circuitOpen)
      throw new SmsKitError("CIRCUIT_OPEN", "sending circuit is open");
  }
  private async enforceIpLimit(
    policy: VerificationPolicy,
    input: IssueSystemAuthChallengeInput,
    templateKey: string,
    now: Date,
    tx: SmsTransaction,
  ): Promise<void> {
    if (input.ipAddress === undefined) return;
    const scopeHash = await this.dependencies.hasher.hash(
      `system-auth:ip:${templateKey}:${input.ipAddress}`,
    );
    const start = new Date(
      Math.floor(now.getTime() / (policy.ipWindowSeconds * 1_000)) *
        policy.ipWindowSeconds *
        1_000,
    );
    const count = await this.dependencies.store.rateLimits.increment(
      {
        ownership: SYSTEM_SCOPE,
        scope: "ip_purpose",
        scopeHash,
        windowStart: start,
        windowSeconds: policy.ipWindowSeconds,
        expiresAt: new Date(start.getTime() + policy.ipWindowSeconds * 1_000),
      },
      tx,
    );
    if (count > policy.ipWindowLimit)
      throw new SmsKitError("RATE_LIMITED", "IP challenge limit is exceeded");
  }
  private async requireTemplate(
    templateKey: string,
    tx: SmsTransaction,
  ): Promise<SendTarget> {
    const template = await this.dependencies.store.resources.findTemplateByKey(
      { templateKey },
      tx,
    );
    if (
      template === undefined ||
      template.templateType !== "verification" ||
      !template.enabled ||
      !isCloudApproved(template.externalStatus) ||
      template.purpose !== templateKey
    )
      throw new SmsKitError("TEMPLATE_UNAVAILABLE", "template is not usable");
    const signature = await this.dependencies.store.resources.findSignatureById(
      { id: template.signatureId },
      tx,
    );
    if (
      signature === undefined ||
      !signature.enabled ||
      !isCloudApproved(signature.externalStatus)
    )
      throw new SmsKitError(
        "SIGNATURE_UNAVAILABLE",
        "template signature is not usable",
      );
    return { template, signatureName: signature.externalName };
  }
}
type SendTarget = Readonly<{ template: Template; signatureName: string }>;
