import { SmsKitError } from "../core/errors.js";
import { normalizeMainlandPhone } from "../core/phone.js";
import { isCloudApproved } from "../core/resource-usability.js";
import { validateTemplateVariables } from "../core/template.js";
import type { TenantId } from "../core/types.js";
import type { PolicyStore } from "../ports/policy.js";
import { positiveTimeoutMs, type SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink, IdGenerator } from "../ports/runtime.js";
import type { MessagePayloadProtector, PhoneNumberProtector } from "../ports/security.js";
import type { AttemptRepository, Message, SmsStore, Template } from "../ports/store.js";
import { enforcePhoneSendPolicy } from "./send-policy.js";

export type SendInput = Readonly<{
  /** Supplied by a trusted host-authentication boundary; never copied from an HTTP body. */
  tenantId: TenantId;
  templateKey: string;
  phone: string;
  variables: Readonly<Record<string, string>>;
  purpose: string;
  idempotencyKey: string;
}>;
export type EnqueueNotificationInput = SendInput;

export type SendServiceDependencies = Readonly<{
  store: SmsStore;
  provider: SmsProvider;
  phoneProtector: PhoneNumberProtector;
  payloadProtector: MessagePayloadProtector;
  /** Optional overrides make this boundary usable with independently provisioned repositories. */
  policy?: PolicyStore;
  attempts?: AttemptRepository;
  clock: Clock;
  ids: IdGenerator;
  events: EventSink;
  providerTimeoutMs: number;
}>;

type SendTarget = Readonly<{ template: Template; signatureName: string }>;

function requireTrustedTenant(tenantId: TenantId): void {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) throw new SmsKitError("PERMISSION_DENIED", "trusted tenant is required");
}

function validateInput(input: SendInput): void {
  requireTrustedTenant(input.tenantId);
  if (typeof input.purpose !== "string" || input.purpose.trim().length === 0 || typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
    throw new SmsKitError("CONFIG_INVALID", "send input is invalid");
  }
  if (!Object.values(input.variables).every((value) => typeof value === "string")) {
    throw new SmsKitError("TEMPLATE_VARIABLE_INVALID", "template variables must be strings");
  }
}

function providerConfig(config: Awaited<ReturnType<SmsStore["config"]["get"]>>) {
  if (config.status === "unconfigured" || config.status !== "ready" || !config.enabled) {
    throw new SmsKitError("CONFIG_INVALID", "provider configuration is not ready");
  }
  return { region: config.region, ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }), accessKeyId: config.accessKeyIdRef, accessKeySecret: config.accessKeySecretRef };
}

/** Persists safe send state before external dispatch; acceptance and delivery deliberately remain distinct. */
export class SendService {
  constructor(private readonly dependencies: SendServiceDependencies) {}

  async enqueueNotification(input: EnqueueNotificationInput): Promise<Message> {
    validateInput(input);
    const target = await this.requireUsableTemplate(input);
    const phone = normalizeMainlandPhone(input.phone);
    const id = this.dependencies.ids.messageId();
    const [protectedPhone, protectedParams] = await Promise.all([
      this.dependencies.phoneProtector.protect(phone, { envelopeVersion: 1, purpose: "phone", tenantId: input.tenantId, recordId: id, fieldName: "phone_ciphertext" }),
      this.dependencies.payloadProtector.seal(input.variables, { envelopeVersion: 1, purpose: "render-params", tenantId: input.tenantId, recordId: id, fieldName: "render_params_ciphertext" }),
    ]);
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.store.transaction((tx) => this.dependencies.store.messages.createWithSendJob({
      id, tenantId: input.tenantId, idempotencyKey: input.idempotencyKey, templateId: target.template.id,
      templateKeySnapshot: target.template.templateKey, externalTemplateCodeSnapshot: target.template.externalCode,
      signatureNameSnapshot: target.signatureName, purpose: input.purpose, phoneCiphertext: protectedPhone.ciphertext,
      phoneKeyId: protectedPhone.keyId, phoneHash: protectedPhone.lookupHash, phoneLast4: protectedPhone.last4, phoneMasked: protectedPhone.masked,
      variableNames: target.template.variables.map((variable) => variable.name), renderParamsCiphertext: protectedParams.ciphertext,
      renderParamsKeyId: protectedParams.keyId, metadata: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] }, submittedAt: now,
      sendJob: { id: this.dependencies.ids.next(), dedupeKey: input.idempotencyKey, availableAt: now, maxAttempts: 3 },
    }, tx));
    await this.dependencies.events.emit({ name: "sms.notification.enqueued", tenantId: input.tenantId, metadata: { counts: [{ name: "message", value: result.created ? 1 : 0 }] } });
    return result.message;
  }

  async sendOtpNow(input: SendInput): Promise<Message> {
    validateInput(input);
    const target = await this.requireUsableTemplate(input);
    const phone = normalizeMainlandPhone(input.phone);
    const id = this.dependencies.ids.messageId();
    const protectedPhone = await this.dependencies.phoneProtector.protect(phone, { envelopeVersion: 1, purpose: "phone", tenantId: input.tenantId, recordId: id, fieldName: "phone_ciphertext" });
    const policyStore = this.dependencies.policy ?? this.dependencies.store.policy;
    const attempts = this.dependencies.attempts ?? this.dependencies.store.attempts;
    const prepared = await this.dependencies.store.transaction(async (tx) => {
      const policy = await policyStore.get(tx);
      if (policy.circuitOpen) throw new SmsKitError("CIRCUIT_OPEN", "sending circuit is open");
      const now = this.dependencies.clock.now();
      const created = await this.dependencies.store.messages.createWithSendJob({
        id, tenantId: input.tenantId, idempotencyKey: input.idempotencyKey, templateId: target.template.id,
        templateKeySnapshot: target.template.templateKey, externalTemplateCodeSnapshot: target.template.externalCode,
        signatureNameSnapshot: target.signatureName, purpose: input.purpose, phoneCiphertext: protectedPhone.ciphertext,
        phoneKeyId: protectedPhone.keyId, phoneHash: protectedPhone.lookupHash, phoneLast4: protectedPhone.last4, phoneMasked: protectedPhone.masked,
        variableNames: target.template.variables.map((variable) => variable.name), metadata: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] }, submittedAt: now,
      }, tx);
      // An existing direct message is authoritative: OTPs are never automatically resent.
      if (!created.created) return { message: created.message, dispatchToken: undefined };
      await enforcePhoneSendPolicy({ policy, rateLimits: this.dependencies.store.rateLimits, tenantId: input.tenantId, phoneHash: protectedPhone.lookupHash, purpose: input.purpose, now, tx });
      await policyStore.holdBudget({ tenantId: input.tenantId, messageId: created.message.id, now }, tx);
      const attempt = await attempts.createStarted({ tenantId: input.tenantId, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: now }, tx);
      return { message: created.message, dispatchToken: attempt.dispatchToken };
    });
    if (prepared.dispatchToken === undefined) return prepared.message;

    const startedAt = this.dependencies.clock.now();
    let outcome: Awaited<ReturnType<SmsProvider["send"]>>;
    try {
      outcome = await this.dependencies.provider.send({ ...providerConfig(await this.dependencies.store.config.get()), phoneNumber: phone, signatureName: target.signatureName, templateCode: target.template.externalCode, templateParams: input.variables, outId: prepared.message.id, timeoutMs: positiveTimeoutMs(this.dependencies.providerTimeoutMs) });
    } catch {
      outcome = { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
    }
    const occurredAt = this.dependencies.clock.now();
    const latencyMs = occurredAt.getTime() - startedAt.getTime();
    if (outcome.kind === "accepted") {
      const completed = await this.complete(input.tenantId, prepared.dispatchToken, "accepted", occurredAt, { providerBizId: outcome.bizId, providerRequestId: outcome.requestId, latencyMs });
      await this.dependencies.events.emit({ name: "sms.otp.accepted", tenantId: input.tenantId, metadata: { counts: [{ name: "attempt", value: 1 }] } });
      return completed;
    }
    if (outcome.kind === "unknown") {
      await this.complete(input.tenantId, prepared.dispatchToken, "unknown", occurredAt, { errorCode: outcome.code, latencyMs });
      throw new SmsKitError("ACCEPTANCE_UNKNOWN", "provider acceptance is unknown");
    }
    await this.complete(input.tenantId, prepared.dispatchToken, "rejected", occurredAt, { ...(outcome.requestId === undefined ? {} : { providerRequestId: outcome.requestId }), providerCode: outcome.code, errorCode: outcome.code, latencyMs });
    if (!outcome.retryable) await this.dependencies.store.transaction((tx) => policyStore.releaseBudget({ tenantId: input.tenantId, messageId: prepared.message.id }, tx));
    throw new SmsKitError(outcome.retryable ? "PROVIDER_THROTTLED" : "PROVIDER_REJECTED", "provider rejected the SMS", outcome.retryable, undefined, outcome.code);
  }

  private async requireUsableTemplate(input: SendInput): Promise<SendTarget> {
    const template = await this.dependencies.store.resources.findTemplateByKey({ templateKey: input.templateKey });
    if (template === undefined || !template.enabled || !isCloudApproved(template.externalStatus) || template.purpose !== input.purpose) {
      throw new SmsKitError("TEMPLATE_UNAVAILABLE", "template is not usable");
    }
    validateTemplateVariables(template.variables.map((variable) => variable.name), input.variables);
    const signatures = await this.dependencies.store.resources.listSignatures({ page: 1, pageSize: 10_000 });
    const signature = signatures.items.find((candidate) => candidate.id === template.signatureId);
    if (signature === undefined || !signature.enabled || !isCloudApproved(signature.externalStatus)) throw new SmsKitError("SIGNATURE_UNAVAILABLE", "template signature is not usable");
    return { template, signatureName: signature.externalName };
  }

  private async complete(tenantId: TenantId, dispatchToken: string, status: "accepted" | "rejected" | "unknown", occurredAt: Date, detail: Readonly<{ providerBizId?: string; providerRequestId?: string; providerCode?: string; errorCode?: string; latencyMs: number }>): Promise<Message> {
    const attempts = this.dependencies.attempts ?? this.dependencies.store.attempts;
    return this.dependencies.store.transaction(async (tx) => {
      const message = await this.dependencies.store.messages.completeAcceptance({ tenantId, dispatchToken, status, evidence: "same-dispatch-response", ...(detail.providerBizId === undefined ? {} : { providerBizId: detail.providerBizId }), ...(detail.providerRequestId === undefined ? {} : { providerRequestId: detail.providerRequestId }), ...(detail.errorCode === undefined ? {} : { finalErrorCode: detail.errorCode }), occurredAt }, tx);
      await attempts.completeByDispatchToken({ tenantId, dispatchToken, status, ...(detail.providerRequestId === undefined ? {} : { providerRequestId: detail.providerRequestId }), ...(detail.providerCode === undefined ? {} : { providerCode: detail.providerCode }), ...(detail.errorCode === undefined ? {} : { errorCode: detail.errorCode }), latencyMs: detail.latencyMs, occurredAt }, tx);
      return message;
    });
  }
}
