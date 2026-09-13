import type { Clock } from "../ports/runtime.js";
import type { SmsStore } from "../ports/store.js";

export type DispatchRecoveryServiceDependencies = Readonly<{ store: SmsStore; clock: Clock }>;
export type DispatchRecoveryRunInput = Readonly<{ limit: number; abandonedBefore: Date }>;

/** Converts abandoned dispatch markers to acceptance-unknown without ever resending. */
export class DispatchRecoveryService {
  constructor(private readonly dependencies: DispatchRecoveryServiceDependencies) {}

  async runBatch(input: DispatchRecoveryRunInput): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit <= 0 || Number.isNaN(input.abandonedBefore.getTime())) {
      throw new RangeError("recovery limit and cutoff are required");
    }
    // A lease with no marker was lost before its first irreversible boundary;
    // returning it to pending is safe. A marker is always recovered as unknown.
    await this.dependencies.store.jobs.recoverExpiredUnstarted({ before: input.abandonedBefore, limit: input.limit });
    return this.dependencies.store.transaction(async (tx) => {
      const attempts = await this.dependencies.store.attempts.listExpiredStarted({ before: input.abandonedBefore, limit: input.limit }, tx);
      for (const attempt of attempts) {
        const occurredAt = this.dependencies.clock.now();
        const message = await this.dependencies.store.messages.completeAcceptance({
          tenantId: attempt.tenantId,
          dispatchToken: attempt.dispatchToken,
          status: "unknown",
          evidence: "same-dispatch-response",
          finalErrorCode: "ACCEPTANCE_UNKNOWN",
          occurredAt,
        }, tx);
        await this.dependencies.store.attempts.completeByDispatchToken({
          tenantId: attempt.tenantId,
          dispatchToken: attempt.dispatchToken,
          status: "unknown",
          errorCode: "ACCEPTANCE_UNKNOWN",
          occurredAt,
        }, tx);
        await this.dependencies.store.messages.clearRenderParams({ tenantId: attempt.tenantId, id: message.id }, tx);
        await this.dependencies.store.jobs.ensureReconcile({ tenantId: attempt.tenantId, messageId: message.id, availableAt: occurredAt }, tx);
        if (attempt.leaseToken !== undefined) {
          await this.dependencies.store.jobs.trySucceedByLeaseToken({
            tenantId: attempt.tenantId,
            messageId: attempt.messageId,
            leaseToken: attempt.leaseToken,
          }, tx);
        }
      }
      return attempts.length;
    });
  }
}
