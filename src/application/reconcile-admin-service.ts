import { SmsKitError } from "../core/errors.js";
import type { MessageId, TenantId } from "../core/types.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
import type { AuthorizationActor, Authorizer } from "../ports/security.js";
import type { Job, JobOriginAction, Message, SmsStore, SmsTransaction } from "../ports/store.js";
import { executeAdminOperation, findAdminOperationReplay } from "./admin-operation.js";

const MAX_PROVIDER_BIZ_ID_LENGTH = 128;

export type EnqueueReconciliationInput = Readonly<{
  expectedVersion: number;
  idempotencyKey: string;
  messageId?: MessageId;
  providerBizId?: string;
}>;

/** The safe subset needed by an admin response and durable replay record. */
export type ReconciliationJob = Readonly<{
  id: string;
  jobType: "reconcile";
  state: Job["state"];
  messageId?: MessageId;
  availableAt: Date;
  attemptCount: number;
  maxAttempts: number;
  /** Internal source fence used only before an idempotent result is returned. */
  originAction?: JobOriginAction;
}>;

export type EnqueueReconciliationResult =
  | Readonly<{ kind: "scheduled"; job: ReconciliationJob }>
  | Readonly<{ kind: "not-found" }>;

export type ReconcileAdminServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  store: SmsStore;
  authorizer: Authorizer<Actor>;
  clock: Clock;
  ids: Pick<IdGenerator, "next">;
}>;

function invalidInput(): never {
  throw new SmsKitError("CONFIG_INVALID", "invalid reconciliation request");
}

function assertInput(input: EnqueueReconciliationInput): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 512 ||
      (input.messageId === undefined && input.providerBizId === undefined) ||
      (input.messageId !== undefined && (typeof input.messageId !== "string" || input.messageId.trim().length === 0 || input.messageId.length > 256)) ||
      (input.providerBizId !== undefined && (typeof input.providerBizId !== "string" || input.providerBizId.trim().length === 0 || input.providerBizId.length > MAX_PROVIDER_BIZ_ID_LENGTH))) {
    invalidInput();
  }
}

function reconciliationJob(value: Job): ReconciliationJob {
  if (value.jobType !== "reconcile" || !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0 ||
      !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < 0) {
    throw new SmsKitError("STORAGE_FAILURE", "reconciliation job is invalid", true);
  }
  return {
    id: value.id,
    jobType: "reconcile",
    state: value.state,
    ...(value.messageId === undefined ? {} : { messageId: value.messageId }),
    availableAt: value.availableAt,
    attemptCount: value.attemptCount,
    maxAttempts: value.maxAttempts,
    ...(value.originAction === undefined ? {} : { originAction: value.originAction }),
  };
}

/** Only a safe, non-tenant job projection is persisted for a replay. */
function jobSnapshot(value: ReconciliationJob): Readonly<Record<string, unknown>> {
  return {
    kind: "receipt-reconcile-job",
    id: value.id,
    jobType: value.jobType,
    state: value.state,
    ...(value.messageId === undefined ? {} : { messageId: value.messageId }),
    availableAt: value.availableAt.toISOString(),
    attemptCount: value.attemptCount,
    maxAttempts: value.maxAttempts,
    ...(value.originAction === undefined ? {} : { originAction: value.originAction }),
  };
}

function snapshotString(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > 512) {
    throw new TypeError(`invalid ${field}`);
  }
  return candidate;
}

function snapshotCount(value: Readonly<Record<string, unknown>>, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError(`invalid ${field}`);
  }
  return candidate;
}

function jobFromSnapshot(value: Readonly<Record<string, unknown>>): ReconciliationJob {
  if (value.kind !== "receipt-reconcile-job" || value.jobType !== "reconcile" ||
      (value.state !== "pending" && value.state !== "leased" && value.state !== "succeeded" && value.state !== "failed" && value.state !== "dead")) {
    throw new TypeError("invalid reconciliation job snapshot");
  }
  const availableAt = new Date(snapshotString(value, "availableAt"));
  if (Number.isNaN(availableAt.getTime())) throw new TypeError("invalid availableAt");
  const messageId = value.messageId;
  if (messageId !== undefined && (typeof messageId !== "string" || messageId.trim().length === 0 || messageId.length > 256)) {
    throw new TypeError("invalid messageId");
  }
  const originAction = value.originAction;
  if (originAction !== undefined && originAction !== "sms.test" && originAction !== "receipt.reconcile") {
    throw new TypeError("invalid originAction");
  }
  return {
    id: snapshotString(value, "id"),
    jobType: "reconcile",
    state: value.state,
    ...(messageId === undefined ? {} : { messageId: messageId as MessageId }),
    availableAt,
    attemptCount: snapshotCount(value, "attemptCount"),
    maxAttempts: snapshotCount(value, "maxAttempts"),
    ...(originAction === undefined ? {} : { originAction }),
  };
}

function request(input: EnqueueReconciliationInput): Readonly<Record<string, unknown>> {
  return {
    expectedVersion: input.expectedVersion,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    ...(input.providerBizId === undefined ? {} : { providerBizId: input.providerBizId }),
  };
}

function eligible(message: Message, expectedVersion: number): void {
  if (message.version !== expectedVersion) {
    throw new SmsKitError("CONCURRENT_MODIFICATION", "message changed concurrently");
  }
  if ((message.acceptanceStatus !== "accepted" && message.acceptanceStatus !== "unknown") || message.deliveryStatus !== "waiting") {
    throw new SmsKitError("CONFIG_INVALID", "message is not eligible for reconciliation");
  }
}

/**
 * Finds a target only through tenant-scoped message repository methods.  A
 * mismatched pair is treated like a missing record so provider identifiers
 * cannot be used to infer another tenant's data.
 */
async function target(
  store: SmsStore,
  tenantId: TenantId,
  input: EnqueueReconciliationInput,
  tx?: SmsTransaction,
): Promise<Message | undefined> {
  const byId = input.messageId === undefined
    ? undefined
    : await store.messages.get({ tenantId, id: input.messageId }, tx);
  if (input.messageId !== undefined && byId === undefined) return undefined;
  const byBizId = input.providerBizId === undefined
    ? undefined
    : await store.messages.findByProviderBizId({ tenantId, bizId: input.providerBizId }, tx);
  if (input.providerBizId !== undefined && byBizId === undefined) return undefined;
  if (byId !== undefined && byBizId !== undefined && byId.id !== byBizId.id) return undefined;
  const resolved = byId ?? byBizId;
  // findByProviderBizId is deliberately a normal tenant-scoped lookup for
  // other callers. Re-read the selected row through get inside this write
  // transaction to keep the version fence locked through job creation.
  return tx === undefined || resolved === undefined
    ? resolved
    : store.messages.get({ tenantId, id: resolved.id }, tx);
}

/**
 * Enqueues, rather than executes, a manual receipt reconciliation.  The
 * worker remains the only component allowed to contact the provider.
 */
export class ReconcileAdminService<Actor extends AuthorizationActor = AuthorizationActor> {
  constructor(private readonly dependencies: ReconcileAdminServiceDependencies<Actor>) {}

  /**
   * A system/ordinary-message job has no originating admin authority, so a
   * tenant-scoped receipt reconciliation may safely reuse it. A job inherited
   * from an admin test send retains that stronger source permission: never let
   * a receipt-only caller learn or replay it.
   */
  private async authorizeReturnedJob(actor: Actor, job: ReconciliationJob): Promise<void> {
    if (job.originAction === undefined || job.originAction === "receipt.reconcile") return;
    if (job.originAction === "sms.test") {
      await this.dependencies.authorizer.assert(actor, "sms.test");
      return;
    }
    throw new SmsKitError("CONCURRENT_MODIFICATION", "reconciliation job source is unavailable");
  }

  async enqueue(actor: Actor, input: EnqueueReconciliationInput): Promise<EnqueueReconciliationResult> {
    await this.dependencies.authorizer.assert(actor, "receipt.reconcile");
    assertInput(input);
    const operationRequest = request(input);
    const replay = await findAdminOperationReplay({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "receipt.reconcile",
      idempotencyKey: input.idempotencyKey,
      request: operationRequest,
      decode: jobFromSnapshot,
    });
    if (replay !== undefined) {
      await this.authorizeReturnedJob(actor, replay);
      return { kind: "scheduled", job: replay };
    }

    // Do the externally visible missing/foreign decision before claiming an
    // operation, so failed probes do not leave durable operation records.
    if (await target(this.dependencies.store, actor.tenantId, input) === undefined) {
      return { kind: "not-found" };
    }

    const execution = await executeAdminOperation({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "receipt.reconcile",
      idempotencyKey: input.idempotencyKey,
      request: operationRequest,
      encode: jobSnapshot,
      decode: jobFromSnapshot,
      work: async (tx) => {
        const message = await target(this.dependencies.store, actor.tenantId, input, tx);
        if (message === undefined) {
          // The preliminary read was tenant-safe. A disappearance while the
          // claim is held is a true race, not a way to reveal foreign data.
          throw new SmsKitError("CONCURRENT_MODIFICATION", "message changed concurrently");
        }
        eligible(message, input.expectedVersion);
        const job = await this.dependencies.store.jobs.ensureReconcile({
          tenantId: actor.tenantId,
          messageId: message.id,
          availableAt: this.dependencies.clock.now(),
          originAction: "receipt.reconcile",
        }, tx);
        const result = reconciliationJob(job);
        await this.authorizeReturnedJob(actor, result);
        if (result.originAction === undefined) {
          await this.dependencies.store.adminOperations.authorizeJob({
            tenantId: actor.tenantId,
            operation: "receipt.reconcile",
            idempotencyKey: input.idempotencyKey,
            jobId: result.id,
            requiredPermission: "receipt.reconcile",
          }, tx);
        }
        await this.dependencies.store.audits.append({
          id: this.dependencies.ids.next(),
          tenantId: actor.tenantId,
          actorId: actor.id,
          action: "receipt.reconcile",
          targetType: "send_message",
          targetId: message.id,
          result: "succeeded",
          metadata: { counts: [{ name: "job", value: 1 }] },
          occurredAt: this.dependencies.clock.now(),
        }, tx);
        return result;
      },
    });
    // A concurrent request can complete this key after the preliminary
    // findAdminOperationReplay check but before claim(). Re-authorize the
    // decoded result here so that race cannot surface another action's job.
    await this.authorizeReturnedJob(actor, execution.value);
    return { kind: "scheduled", job: execution.value };
  }
}
