import { SmsKitError } from "../core/errors.js";
import { positiveTimeoutMs, type SmsProvider, type ProviderSendResult } from "../ports/provider.js";
import type { Clock } from "../ports/runtime.js";
import type { MessagePayloadProtector, PhoneNumberProtector } from "../ports/security.js";
import type { Job, SmsStore } from "../ports/store.js";

export type SendWorkerDependencies = Readonly<{
  store: SmsStore;
  provider: SmsProvider;
  phoneProtector: PhoneNumberProtector;
  payloadProtector: MessagePayloadProtector;
  clock: Clock;
}>;

export type SendWorkerRunInput = Readonly<{
  workerId: string;
  limit: number;
  leaseMs: number;
  providerTimeoutMs: number;
}>;

function assertRunInput(input: SendWorkerRunInput): void {
  if (!Number.isInteger(input.limit) || input.limit <= 0 || !Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
    throw new RangeError("worker limit and lease duration must be positive");
  }
  if (typeof input.workerId !== "string" || input.workerId.trim().length === 0) throw new RangeError("worker id is required");
  positiveTimeoutMs(input.providerTimeoutMs);
  if (input.providerTimeoutMs >= input.leaseMs) throw new RangeError("provider timeout must be shorter than the job lease");
}

function backoff(attemptCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attemptCount));
}

/**
 * Executes notification jobs only after a durable attempt marker has fenced the
 * current job lease. The marker is deliberately committed before any secret is
 * opened or provider request begins, so a process loss is conservative.
 */
export class SendWorker {
  constructor(private readonly dependencies: SendWorkerDependencies) {}

  async runBatch(input: SendWorkerRunInput): Promise<number> {
    assertRunInput(input);
    const leased = await this.dependencies.store.jobs.lease({
      owner: input.workerId,
      jobType: "send",
      limit: input.limit,
      leaseMs: input.leaseMs,
      now: this.dependencies.clock.now(),
    });
    for (const job of leased) await this.runJob(job, input);
    return leased.length;
  }

  private async runJob(job: Job, input: SendWorkerRunInput): Promise<void> {
    if (job.messageId === undefined || job.leaseToken === undefined) return;
    const prepared = await this.dependencies.store.transaction(async (tx) => {
      // createStarted locks the message and proves this exact queued token owns
      // a leased send job. Budget holding is idempotent per message.
      await this.dependencies.store.policy.holdBudget({ tenantId: job.tenantId, messageId: job.messageId!, now: this.dependencies.clock.now() }, tx);
      return this.dependencies.store.attempts.createStarted({
        tenantId: job.tenantId,
        messageId: job.messageId!,
        dispatchMode: "queued",
        leaseToken: job.leaseToken!,
        dispatchMarkedAt: this.dependencies.clock.now(),
      }, tx);
    });

    // Never extend the transaction across decryption, config lookup, or I/O.
    const providerInput = await this.openProviderInput(job, input.providerTimeoutMs);
    const startedAt = this.dependencies.clock.now();
    let result: ProviderSendResult;
    try {
      result = await this.dependencies.provider.send(providerInput);
    } catch {
      result = { kind: "unknown", code: "ACCEPTANCE_UNKNOWN" };
    }
    await this.complete(job, prepared.dispatchToken, result, startedAt);
  }

  private async openProviderInput(job: Job, timeoutMs: number) {
    if (job.messageId === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "send job has no message");
    const [message, config] = await Promise.all([
      this.dependencies.store.messages.get({ tenantId: job.tenantId, id: job.messageId }),
      this.dependencies.store.config.get(),
    ]);
    if (message === undefined || message.phoneCiphertext === undefined || message.phoneKeyId === undefined || message.renderParamsCiphertext === undefined || message.renderParamsKeyId === undefined) {
      throw new SmsKitError("STORAGE_FAILURE", "queued message cannot be dispatched", true);
    }
    if (config.status === "unconfigured" || config.status !== "ready" || !config.enabled) {
      throw new SmsKitError("CONFIG_INVALID", "provider configuration is not ready");
    }
    const [phoneNumber, templateParams] = await Promise.all([
      this.dependencies.phoneProtector.unprotect({ ciphertext: message.phoneCiphertext, keyId: message.phoneKeyId }, { envelopeVersion: 1, purpose: "phone", tenantId: message.tenantId, recordId: message.id, fieldName: "phone_ciphertext" }),
      this.dependencies.payloadProtector.open({ ciphertext: message.renderParamsCiphertext, keyId: message.renderParamsKeyId }, { envelopeVersion: 1, purpose: "render-params", tenantId: message.tenantId, recordId: message.id, fieldName: "render_params_ciphertext" }),
    ]);
    return {
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      accessKeyId: config.accessKeyIdRef,
      accessKeySecret: config.accessKeySecretRef,
      phoneNumber,
      signatureName: message.signatureNameSnapshot,
      templateCode: message.externalTemplateCodeSnapshot,
      templateParams,
      outId: message.id,
      timeoutMs: positiveTimeoutMs(timeoutMs),
    };
  }

  private async complete(job: Job, dispatchToken: string, result: ProviderSendResult, startedAt: Date): Promise<void> {
    if (job.messageId === undefined || job.leaseToken === undefined) return;
    const occurredAt = this.dependencies.clock.now();
    const latencyMs = Math.max(0, occurredAt.getTime() - startedAt.getTime());
    await this.dependencies.store.transaction(async (tx) => {
      const attempts = this.dependencies.store.attempts;
      const messages = this.dependencies.store.messages;
      const jobs = this.dependencies.store.jobs;
      const policy = this.dependencies.store.policy;

      if (result.kind === "accepted") {
        const message = await messages.completeAcceptance({ tenantId: job.tenantId, dispatchToken, status: "accepted", evidence: "same-dispatch-response", providerBizId: result.bizId, providerRequestId: result.requestId, occurredAt }, tx);
        await attempts.completeByDispatchToken({ tenantId: job.tenantId, dispatchToken, status: "accepted", providerRequestId: result.requestId, latencyMs, occurredAt }, tx);
        await messages.clearRenderParams({ tenantId: job.tenantId, id: message.id }, tx);
        await jobs.trySucceed({ tenantId: job.tenantId, id: job.id, leaseToken: job.leaseToken! }, tx);
        return;
      }

      if (result.kind === "unknown") {
        const message = await messages.completeAcceptance({ tenantId: job.tenantId, dispatchToken, status: "unknown", evidence: "same-dispatch-response", finalErrorCode: result.code, occurredAt }, tx);
        await attempts.completeByDispatchToken({ tenantId: job.tenantId, dispatchToken, status: "unknown", errorCode: result.code, latencyMs, occurredAt }, tx);
        await messages.clearRenderParams({ tenantId: job.tenantId, id: message.id }, tx);
        await jobs.ensureReconcile({ tenantId: job.tenantId, messageId: message.id, availableAt: occurredAt }, tx);
        await jobs.trySucceed({ tenantId: job.tenantId, id: job.id, leaseToken: job.leaseToken! }, tx);
        return;
      }

      const current = await messages.get({ tenantId: job.tenantId, id: job.messageId! }, tx);
      if (current === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "queued message no longer exists");
      const exhausted = job.attemptCount + 1 >= job.maxAttempts;
      const mustFinalize = !result.retryable || exhausted || current.acceptanceStatus === "unknown";
      if (mustFinalize) {
        const message = await messages.completeAcceptance({ tenantId: job.tenantId, dispatchToken, status: "rejected", evidence: "same-dispatch-response", ...(result.requestId === undefined ? {} : { providerRequestId: result.requestId }), finalErrorCode: result.code, occurredAt }, tx);
        await attempts.completeByDispatchToken({ tenantId: job.tenantId, dispatchToken, status: "rejected", ...(result.requestId === undefined ? {} : { providerRequestId: result.requestId }), providerCode: result.code, errorCode: result.code, latencyMs, occurredAt }, tx);
        await messages.clearRenderParams({ tenantId: job.tenantId, id: message.id }, tx);
        await policy.releaseBudget({ tenantId: job.tenantId, messageId: message.id }, tx);
        await jobs.tryFail({ tenantId: job.tenantId, id: job.id, leaseToken: job.leaseToken!, errorCode: result.code, terminal: true }, tx);
        return;
      }

      await attempts.completeByDispatchToken({ tenantId: job.tenantId, dispatchToken, status: "rejected", ...(result.requestId === undefined ? {} : { providerRequestId: result.requestId }), providerCode: result.code, errorCode: result.code, latencyMs, occurredAt }, tx);
      await jobs.tryReschedule({ tenantId: job.tenantId, id: job.id, leaseToken: job.leaseToken!, availableAt: new Date(occurredAt.getTime() + backoff(job.attemptCount)), errorCode: result.code }, tx);
    });
  }
}
