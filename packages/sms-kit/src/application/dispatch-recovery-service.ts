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
    return this.dependencies.store.transaction(async (tx) => {
      // Lock jobs before looking for a marker. The next command gets a fresh
      // MVCC snapshot while holding that fence, so a marker cannot be orphaned
      // by a worker that committed between an earlier scan and the job lock.
      const expiredJobs = await this.dependencies.store.jobs.lockExpiredSendJobs({ before: input.abandonedBefore, limit: input.limit }, tx);
      let returnedToPending = 0;
      for (const job of expiredJobs) {
        if (job.leaseToken !== undefined && await this.dependencies.store.jobs.returnToPendingIfNoStarted({ tenantId: job.tenantId, id: job.id, leaseToken: job.leaseToken }, tx)) {
          returnedToPending += 1;
        }
      }
      // Direct attempts have no queue ownership and can be recovered on their
      // own. Queued attempts are deliberately selected only through the exact
      // jobs locked above: never independently lock a queued attempt after its
      // job was skipped by another completion transaction.
      const directAttempts = await this.dependencies.store.attempts.listExpiredStarted({ before: input.abandonedBefore, limit: input.limit }, tx);
      const queuedAttempts = await this.dependencies.store.attempts.listStartedForLeasedJobs({
        jobs: expiredJobs.flatMap((job) => job.leaseToken === undefined ? [] : [{ tenantId: job.tenantId, id: job.id, leaseToken: job.leaseToken }]),
        limit: Math.max(0, input.limit - directAttempts.length),
      }, tx);
      const attempts = [...directAttempts, ...queuedAttempts];
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
        const originatingJob = attempt.leaseToken === undefined
          ? undefined
          : expiredJobs.find((job) => job.tenantId === attempt.tenantId && job.messageId === attempt.messageId && job.leaseToken === attempt.leaseToken);
        await this.dependencies.store.jobs.ensureReconcile({
          tenantId: attempt.tenantId,
          messageId: message.id,
          availableAt: occurredAt,
          ...(originatingJob?.originAction === undefined ? {} : { originAction: originatingJob.originAction }),
        }, tx);
        if (attempt.leaseToken !== undefined) {
          await this.dependencies.store.jobs.trySucceedByLeaseToken({
            tenantId: attempt.tenantId,
            messageId: attempt.messageId,
            leaseToken: attempt.leaseToken,
          }, tx);
        }
      }
      return returnedToPending + attempts.length;
    });
  }
}
