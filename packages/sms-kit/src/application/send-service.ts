import { SmsKitError } from "../core/errors.js";
import { normalizeMainlandPhone } from "../core/phone.js";
import { isCloudApproved } from "../core/resource-usability.js";
import { validateTemplateVariables } from "../core/template.js";
import type { TenantId } from "../core/types.js";
import type { PolicyStore } from "../ports/policy.js";
import { positiveTimeoutMs, type SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink, IdGenerator, TestRecipientAllowlist } from "../ports/runtime.js";
import type { AuthorizationActor, Authorizer, DeterministicRequestFingerprinter, MessagePayloadProtector, PhoneNumberProtector } from "../ports/security.js";
import type { AttemptRepository, Message, SmsStore, SmsTransaction, Template } from "../ports/store.js";
import { enforcePhoneSendPolicy } from "./send-policy.js";
import { withProviderTimeout } from "../ports/provider-timeout.js";
import { canonicalChecksum } from "./checksum.js";
import { executeAdminOperation, findAdminOperationReplay } from "./admin-operation.js";

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

/**
 * A versioned administrative send is intentionally separate from ordinary
 * application sends: its recipient has a host-owned allowlist and its
 * idempotency result is durably replayed without accepting a second message.
 */
export type EnqueueTestNotificationInput = Readonly<{
  expectedVersion: number;
  idempotencyKey: string;
  templateKey: string;
  phone: string;
  variables: Readonly<Record<string, string>>;
  purpose: string;
}>;

export type TestNotificationMessage = Pick<
  Message,
  | "id"
  | "phoneMasked"
  | "phoneLast4"
  | "templateKeySnapshot"
  | "purpose"
  | "acceptanceStatus"
  | "deliveryStatus"
  | "submittedAt"
  | "providerBizId"
  | "finalErrorCode"
>;

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
  /** Required only for /config/test-send; absent configuration fails closed. */
  testRecipientAllowlist?: TestRecipientAllowlist;
  /** Required only for /config/test-send so direct application calls cannot bypass sms.test. */
  testAuthorizer?: Authorizer<AuthorizationActor>;
  /** Deterministic keyed host fingerprint used to avoid persisting test phone/variable inputs. */
  testRequestFingerprinter?: DeterministicRequestFingerprinter;
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

function assertTestInput(actor: AuthorizationActor, input: EnqueueTestNotificationInput): SendInput {
  if (typeof actor.id !== "string" || actor.id.trim().length === 0 ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
      typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 512) {
    throw new SmsKitError("CONFIG_INVALID", "test send input is invalid");
  }
  const sendInput: SendInput = {
    tenantId: actor.tenantId,
    templateKey: input.templateKey,
    phone: input.phone,
    variables: input.variables,
    purpose: input.purpose,
    idempotencyKey: input.idempotencyKey,
  };
  validateInput(sendInput);
  return sendInput;
}

function requireTestConfigVersion(config: Awaited<ReturnType<SmsStore["config"]["get"]>>, expectedVersion: number): void {
  if (config.version !== expectedVersion) {
    throw new SmsKitError("CONCURRENT_MODIFICATION", "provider configuration changed concurrently");
  }
  providerConfig(config);
}

function snapshotString(value: Readonly<Record<string, unknown>>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) throw new TypeError("invalid test send snapshot");
  return result;
}

function optionalSnapshotString(value: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.length === 0) throw new TypeError("invalid test send snapshot");
  return result;
}

function testMessageSnapshot(message: TestNotificationMessage): Readonly<Record<string, unknown>> {
  return {
    kind: "sms.test.send",
    id: message.id,
    templateKeySnapshot: message.templateKeySnapshot,
    purpose: message.purpose,
    acceptanceStatus: message.acceptanceStatus,
    deliveryStatus: message.deliveryStatus,
    submittedAt: message.submittedAt.toISOString(),
    ...(message.providerBizId === undefined ? {} : { providerBizId: message.providerBizId }),
    ...(message.finalErrorCode === undefined ? {} : { finalErrorCode: message.finalErrorCode }),
  };
}

/** Never let direct application callers bypass the same safe test-send projection as HTTP. */
function testMessage(message: Message): TestNotificationMessage {
  return {
    id: message.id,
    templateKeySnapshot: message.templateKeySnapshot,
    purpose: message.purpose,
    acceptanceStatus: message.acceptanceStatus,
    deliveryStatus: message.deliveryStatus,
    submittedAt: message.submittedAt,
    ...(message.providerBizId === undefined ? {} : { providerBizId: message.providerBizId }),
    ...(message.finalErrorCode === undefined ? {} : { finalErrorCode: message.finalErrorCode }),
  };
}

function testMessageFromSnapshot(value: Readonly<Record<string, unknown>>): TestNotificationMessage {
  if (value.kind !== "sms.test.send") throw new TypeError("invalid test send snapshot");
  const acceptanceStatus = snapshotString(value, "acceptanceStatus");
  const deliveryStatus = snapshotString(value, "deliveryStatus");
  if (!(["pending", "accepted", "rejected", "unknown"] as const).includes(acceptanceStatus as Message["acceptanceStatus"]) ||
      !(["not_applicable", "waiting", "delivered", "failed", "unknown_final"] as const).includes(deliveryStatus as Message["deliveryStatus"])) {
    throw new TypeError("invalid test send snapshot");
  }
  const submittedAt = new Date(snapshotString(value, "submittedAt"));
  if (Number.isNaN(submittedAt.getTime())) throw new TypeError("invalid test send snapshot");
  const providerBizId = optionalSnapshotString(value, "providerBizId");
  const finalErrorCode = optionalSnapshotString(value, "finalErrorCode");
  return {
    id: snapshotString(value, "id") as Message["id"],
    templateKeySnapshot: snapshotString(value, "templateKeySnapshot"),
    purpose: snapshotString(value, "purpose"),
    acceptanceStatus: acceptanceStatus as Message["acceptanceStatus"],
    deliveryStatus: deliveryStatus as Message["deliveryStatus"],
    submittedAt,
    ...(providerBizId === undefined ? {} : { providerBizId }),
    ...(finalErrorCode === undefined ? {} : { finalErrorCode }),
  };
}

/** Persists safe send state before external dispatch; acceptance and delivery deliberately remain distinct. */
export class SendService {
  constructor(private readonly dependencies: SendServiceDependencies) {}

  async enqueueNotification(input: EnqueueNotificationInput): Promise<Message> {
    validateInput(input);
    const phone = normalizeMainlandPhone(input.phone);
    const id = this.dependencies.ids.messageId();
    const [protectedPhone, protectedParams] = await Promise.all([
      this.dependencies.phoneProtector.protect(phone, { envelopeVersion: 1, purpose: "phone", tenantId: input.tenantId, recordId: id, fieldName: "phone_ciphertext" }),
      this.dependencies.payloadProtector.seal(input.variables, { envelopeVersion: 1, purpose: "render-params", tenantId: input.tenantId, recordId: id, fieldName: "render_params_ciphertext" }),
    ]);
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.store.transaction(async (tx) => {
      // The shared resource locks remain held through the message insert. A
      // simultaneous stable-key rename therefore observes this send before it
      // can commit, rather than orphaning a just-created snapshot.
      const target = await this.requireUsableTemplate(input, "notification", tx);
      return this.dependencies.store.messages.createWithSendJob({
        id, tenantId: input.tenantId, idempotencyKey: input.idempotencyKey, templateId: target.template.id,
        templateKeySnapshot: target.template.templateKey, externalTemplateCodeSnapshot: target.template.externalCode,
        signatureNameSnapshot: target.signatureName, purpose: input.purpose, phoneCiphertext: protectedPhone.ciphertext,
        phoneKeyId: protectedPhone.keyId, phoneHash: protectedPhone.lookupHash, phoneLast4: protectedPhone.last4, phoneMasked: protectedPhone.masked,
        variableNames: target.template.variables.map((variable) => variable.name), renderParamsCiphertext: protectedParams.ciphertext,
        renderParamsKeyId: protectedParams.keyId, metadata: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] }, submittedAt: now,
        sendJob: { id: this.dependencies.ids.next(), dedupeKey: input.idempotencyKey, availableAt: now, maxAttempts: 3 },
      }, tx);
    });
    await this.dependencies.events.emit({ name: "sms.notification.enqueued", tenantId: input.tenantId, metadata: { counts: [{ name: "message", value: result.created ? 1 : 0 }] } });
    return result.message;
  }

  /**
   * Queues one host-allowlisted administrative message through the normal
   * message/job pipeline. Its durable operation record prevents retries from
   * creating another job, while the snapshot deliberately contains only the
   * same safe fields returned by the admin DTO.
   */
  async enqueueTestNotification(actor: AuthorizationActor, input: EnqueueTestNotificationInput): Promise<TestNotificationMessage> {
    const sendInput = assertTestInput(actor, input);
    const authorizer = this.dependencies.testAuthorizer;
    if (authorizer === undefined) throw new SmsKitError("PERMISSION_DENIED", "test send is not authorized");
    await authorizer.assert(actor, "sms.test");
    const phone = normalizeMainlandPhone(sendInput.phone);
    const requestFingerprinter = this.dependencies.testRequestFingerprinter;
    if (requestFingerprinter === undefined) {
      throw new SmsKitError("STORAGE_FAILURE", "test send idempotency protection is unavailable", true);
    }
    let requestFingerprint: string;
    try {
      // Never hand raw recipient or template values to the admin-operation
      // store. The keyed host hash makes the persisted checksum non-reversible
      // for the low-entropy phone-number space as well.
      const rawFingerprint = canonicalChecksum({
        tenantId: actor.tenantId,
        idempotencyKey: input.idempotencyKey,
        phone,
        templateKey: input.templateKey,
        variables: input.variables,
        purpose: input.purpose,
      });
      requestFingerprint = canonicalChecksum({ keyed: await requestFingerprinter.fingerprint(`sms.test.send:v1:${rawFingerprint}`) });
    } catch {
      throw new SmsKitError("STORAGE_FAILURE", "test send idempotency protection is unavailable", true);
    }
    const request = { expectedVersion: input.expectedVersion, requestFingerprint };
    const replay = await findAdminOperationReplay({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "sms.test.send",
      idempotencyKey: input.idempotencyKey,
      request,
      decode: testMessageFromSnapshot,
    });
    if (replay !== undefined) return replay;

    // The allowlist guards only a new external-effecting request. A completed
    // operation is tenant-scoped and must replay its committed safe snapshot
    // even if a host policy later changes or is temporarily unavailable.
    const allowlist = this.dependencies.testRecipientAllowlist;
    if (allowlist === undefined) {
      throw new SmsKitError("PERMISSION_DENIED", "test recipient is not allowed");
    }
    let allowed: boolean;
    try {
      allowed = await allowlist.allows({ tenantId: actor.tenantId, actorId: actor.id, phone });
    } catch {
      throw new SmsKitError("STORAGE_FAILURE", "test recipient policy is unavailable", true);
    }
    if (!allowed) throw new SmsKitError("PERMISSION_DENIED", "test recipient is not allowed");

    const currentConfig = await this.dependencies.store.config.get();
    requireTestConfigVersion(currentConfig, input.expectedVersion);
    const id = this.dependencies.ids.messageId();
    const [protectedPhone, protectedParams] = await Promise.all([
      this.dependencies.phoneProtector.protect(phone, { envelopeVersion: 1, purpose: "phone", tenantId: actor.tenantId, recordId: id, fieldName: "phone_ciphertext" }),
      this.dependencies.payloadProtector.seal(input.variables, { envelopeVersion: 1, purpose: "render-params", tenantId: actor.tenantId, recordId: id, fieldName: "render_params_ciphertext" }),
    ]);
    const submittedAt = this.dependencies.clock.now();
    const messageIdempotencyKey = `admin-test:${canonicalChecksum({ tenantId: actor.tenantId, requestFingerprint })}`;
    const execution = await executeAdminOperation({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "sms.test.send",
      idempotencyKey: input.idempotencyKey,
      request,
      encode: testMessageSnapshot,
      decode: testMessageFromSnapshot,
      work: async (tx) => {
        const lockedConfig = await this.dependencies.store.config.get(tx);
        requireTestConfigVersion(lockedConfig, input.expectedVersion);
        // This lookup obtains the template and then parent signature shared
        // locks, held through the message insert just like ordinary sends.
        const target = await this.requireUsableTemplate(sendInput, "notification", tx);
        const created = await this.dependencies.store.messages.createWithSendJob({
          id,
          tenantId: actor.tenantId,
          idempotencyKey: messageIdempotencyKey,
          templateId: target.template.id,
          templateKeySnapshot: target.template.templateKey,
          externalTemplateCodeSnapshot: target.template.externalCode,
          signatureNameSnapshot: target.signatureName,
          purpose: input.purpose,
          phoneCiphertext: protectedPhone.ciphertext,
          phoneKeyId: protectedPhone.keyId,
          phoneHash: protectedPhone.lookupHash,
          phoneLast4: protectedPhone.last4,
          phoneMasked: protectedPhone.masked,
          variableNames: target.template.variables.map((variable) => variable.name),
          renderParamsCiphertext: protectedParams.ciphertext,
          renderParamsKeyId: protectedParams.keyId,
          metadata: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] },
          submittedAt,
          sendJob: {
            id: this.dependencies.ids.next(),
            dedupeKey: messageIdempotencyKey,
            availableAt: submittedAt,
            maxAttempts: 3,
            originAction: "sms.test",
          },
        }, tx);
        if (!created.created) {
          // The operation claim and message insert share a transaction, so an
          // existing derived key can only indicate a broken/colliding host
          // idempotency implementation, never a valid replay.
          throw new SmsKitError("IDEMPOTENCY_CONFLICT", "test send idempotency key is already in use");
        }
        await this.dependencies.store.audits.append({
          id: this.dependencies.ids.next(),
          tenantId: actor.tenantId,
          actorId: actor.id,
          action: "sms.test.send",
          targetType: "send_message",
          targetId: created.message.id,
          result: "succeeded",
          metadata: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] },
          occurredAt: this.dependencies.clock.now(),
        }, tx);
        return testMessage(created.message);
      },
    });
    if (!execution.replay) {
      await this.dependencies.events.emit({
        name: "sms.test.enqueued",
        tenantId: actor.tenantId,
        metadata: { redactedFields: ["phone", "template-params"], counts: [{ name: "message", value: 1 }] },
      });
    }
    return execution.value;
  }

  async sendOtpNow(input: SendInput): Promise<Message> {
    validateInput(input);
    // Deterministic local failures must happen before any durable dispatch marker.
    const auth = providerConfig(await this.dependencies.store.config.get());
    const timeoutMs = positiveTimeoutMs(this.dependencies.providerTimeoutMs);
    const phone = normalizeMainlandPhone(input.phone);
    const id = this.dependencies.ids.messageId();
    const protectedPhone = await this.dependencies.phoneProtector.protect(phone, { envelopeVersion: 1, purpose: "phone", tenantId: input.tenantId, recordId: id, fieldName: "phone_ciphertext" });
    const policyStore = this.dependencies.policy ?? this.dependencies.store.policy;
    const attempts = this.dependencies.attempts ?? this.dependencies.store.attempts;
    const prepared = await this.dependencies.store.transaction(async (tx) => {
      const target = await this.requireUsableTemplate(input, "verification", tx);
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
      if (!created.created) return { message: created.message, dispatchToken: undefined, target };
      await enforcePhoneSendPolicy({ policy, rateLimits: this.dependencies.store.rateLimits, tenantId: input.tenantId, phoneHash: protectedPhone.lookupHash, purpose: input.purpose, now, tx });
      await policyStore.holdBudget({ tenantId: input.tenantId, messageId: created.message.id, now }, tx);
      const attempt = await attempts.createStarted({ tenantId: input.tenantId, messageId: created.message.id, dispatchMode: "direct", dispatchMarkedAt: now }, tx);
      return { message: created.message, dispatchToken: attempt.dispatchToken, target };
    });
    if (prepared.dispatchToken === undefined) return prepared.message;

    const startedAt = this.dependencies.clock.now();
    let outcome: Awaited<ReturnType<SmsProvider["send"]>>;
    try {
      outcome = await withProviderTimeout(() => this.dependencies.provider.send({ ...auth, phoneNumber: phone, signatureName: prepared.target.signatureName, templateCode: prepared.target.template.externalCode, templateParams: input.variables, outId: prepared.message.id, timeoutMs }), timeoutMs);
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
    await this.complete(input.tenantId, prepared.dispatchToken, "rejected", occurredAt, { ...(outcome.requestId === undefined ? {} : { providerRequestId: outcome.requestId }), providerCode: outcome.code, errorCode: outcome.code, latencyMs }, true);
    throw new SmsKitError(outcome.retryable ? "PROVIDER_THROTTLED" : "PROVIDER_REJECTED", "provider rejected the SMS", outcome.retryable, undefined, outcome.code);
  }

  private async requireUsableTemplate(
    input: SendInput,
    templateType: Template["templateType"],
    tx: SmsTransaction,
  ): Promise<SendTarget> {
    const template = await this.dependencies.store.resources.findTemplateByKey({ templateKey: input.templateKey }, tx);
    if (template === undefined || template.templateType !== templateType || !template.enabled || !isCloudApproved(template.externalStatus) || template.purpose !== input.purpose) {
      throw new SmsKitError("TEMPLATE_UNAVAILABLE", "template is not usable");
    }
    validateTemplateVariables(template.variables.map((variable) => variable.name), input.variables);
    const signature = await this.dependencies.store.resources.findSignatureById({ id: template.signatureId }, tx);
    if (signature === undefined || !signature.enabled || !isCloudApproved(signature.externalStatus)) throw new SmsKitError("SIGNATURE_UNAVAILABLE", "template signature is not usable");
    return { template, signatureName: signature.externalName };
  }

  private async complete(tenantId: TenantId, dispatchToken: string, status: "accepted" | "rejected" | "unknown", occurredAt: Date, detail: Readonly<{ providerBizId?: string; providerRequestId?: string; providerCode?: string; errorCode?: string; latencyMs: number }>, releaseBudget = false): Promise<Message> {
    const attempts = this.dependencies.attempts ?? this.dependencies.store.attempts;
    return this.dependencies.store.transaction(async (tx) => {
      const message = await this.dependencies.store.messages.completeAcceptance({ tenantId, dispatchToken, status, evidence: "same-dispatch-response", ...(detail.providerBizId === undefined ? {} : { providerBizId: detail.providerBizId }), ...(detail.providerRequestId === undefined ? {} : { providerRequestId: detail.providerRequestId }), ...(detail.errorCode === undefined ? {} : { finalErrorCode: detail.errorCode }), occurredAt }, tx);
      await attempts.completeByDispatchToken({ tenantId, dispatchToken, status, ...(detail.providerRequestId === undefined ? {} : { providerRequestId: detail.providerRequestId }), ...(detail.providerCode === undefined ? {} : { providerCode: detail.providerCode }), ...(detail.errorCode === undefined ? {} : { errorCode: detail.errorCode }), latencyMs: detail.latencyMs, occurredAt }, tx);
      if (status === "accepted" || status === "unknown") await this.dependencies.store.jobs.ensureReconcile({ tenantId, messageId: message.id, availableAt: occurredAt }, tx);
      if (releaseBudget) await (this.dependencies.policy ?? this.dependencies.store.policy).releaseBudget({ tenantId, messageId: message.id }, tx);
      return message;
    });
  }
}
