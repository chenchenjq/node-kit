import type { HealthService } from "../../application/health-service.js";
import type { PolicyService } from "../../application/policy-service.js";
import type { ReconcileAdminService, ReconciliationJob } from "../../application/reconcile-admin-service.js";
import { SmsKitError } from "../../core/errors.js";
import { normalizeMainlandPhone } from "../../core/phone.js";
import type { Clock } from "../../ports/runtime.js";
import type { AuthorizationActor, PhoneLookupHasher } from "../../ports/security.js";
import type { DailyStats, Job, Message, SmsStore } from "../../ports/store.js";
import { HttpError } from "../http.js";
import {
  betterAuthVerificationDtoSchema,
  jobDtoSchema,
  messageDetailDtoSchema,
  messagePageDtoSchema,
  receiptHealthDtoSchema,
  smsErrorCodeSchema,
  smsStatsDtoSchema,
  verificationSettingsDtoSchema,
  type BetterAuthVerificationDto,
  type ReconcileInput,
  type UpdateVerificationSettingsInput,
} from "../types/index.js";
import { messageDto } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_STATS_RANGE_DAYS = 366;
const RATE_SCALE = 1_000_000_000_000n;

type OperationsStore = Pick<SmsStore, "messages" | "attempts" | "receipts" | "stats" | "jobs" | "adminOperations">;

export type BetterAuthVerificationSettingsSource<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  /** Must return the host's actual adapter construction snapshot, never inferred template names. */
  get(actor: Actor): BetterAuthVerificationDto | Promise<BetterAuthVerificationDto>;
}>;

/** Services consumed by Task 4 routes; all stateful behavior stays in sms-kit. */
export type SmsOperationsRouteServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  policy?: Pick<PolicyService<Actor>, "get" | "patch">;
  health?: Pick<HealthService, "getSnapshot">;
  reconcile?: Pick<ReconcileAdminService<Actor>, "enqueue">;
  store?: OperationsStore;
  /** Read-only keyed phone lookup dependency; it never creates ciphertext. */
  phoneProtector?: Pick<PhoneLookupHasher, "lookupHash">;
  /** Read-only host-owned Better Auth integration state. */
  betterAuth?: BetterAuthVerificationSettingsSource<Actor>;
  clock?: Clock;
}>;

export type OperationJobAuthorization = Readonly<{
  requiredPermission: "sms.test" | "receipt.reconcile";
}>;

function requireService<T>(value: T | undefined): T {
  if (value === undefined) throw new SmsKitError("STORAGE_FAILURE", "admin route service is unavailable", true);
  return value;
}

function iso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SmsKitError("STORAGE_FAILURE", "stored timestamp is invalid", true);
  }
  return value.toISOString();
}

function safeErrorCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = smsErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function jobDto(value: Pick<Job, "id" | "jobType" | "state" | "messageId" | "availableAt" | "attemptCount" | "maxAttempts" | "lastErrorCode"> | ReconciliationJob) {
  const lastErrorCode = "lastErrorCode" in value ? safeErrorCode(value.lastErrorCode) : undefined;
  return jobDtoSchema.parse({
    id: value.id,
    jobType: value.jobType,
    state: value.state,
    ...(value.messageId === undefined ? {} : { messageId: value.messageId }),
    availableAt: iso(value.availableAt),
    attemptCount: value.attemptCount,
    maxAttempts: value.maxAttempts,
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
  });
}

async function messageProjection(store: OperationsStore, message: Message) {
  const attemptCount = await store.attempts.countForMessage({ tenantId: message.tenantId, messageId: message.id });
  return messageDto({ ...message, attemptCount });
}

async function messageDetailProjection(store: OperationsStore, message: Message) {
  const [base, attempts, receipts] = await Promise.all([
    messageProjection(store, message),
    store.attempts.listForMessage({ tenantId: message.tenantId, messageId: message.id }),
    store.receipts.listForMessage({ tenantId: message.tenantId, messageId: message.id }),
  ]);
  return messageDetailDtoSchema.parse({
    ...base,
    version: message.version,
    ...(message.acceptedAt === undefined ? {} : { acceptedAt: iso(message.acceptedAt) }),
    ...(message.deliveredAt === undefined ? {} : { deliveredAt: iso(message.deliveredAt) }),
    ...(message.finalizedAt === undefined ? {} : { finalizedAt: iso(message.finalizedAt) }),
    ...(message.providerRequestId === undefined ? {} : { providerRequestId: message.providerRequestId }),
    attempts: attempts.map((attempt) => ({
      attemptNo: attempt.attemptNo,
      status: attempt.status,
      dispatchMode: attempt.dispatchMode,
      dispatchMarkedAt: iso(attempt.dispatchMarkedAt),
      occurredAt: iso(attempt.occurredAt),
      ...(attempt.providerRequestId === undefined ? {} : { providerRequestId: attempt.providerRequestId }),
      ...(safeErrorCode(attempt.errorCode) === undefined ? {} : { errorCode: safeErrorCode(attempt.errorCode) }),
      ...(attempt.latencyMs === undefined ? {} : { latencyMs: attempt.latencyMs }),
    })),
    receipts: receipts.map((receipt) => ({
      source: receipt.source,
      deliveryStatus: receipt.deliveryStatus,
      occurredAt: iso(receipt.occurredAt),
      receivedAt: iso(receipt.receivedAt),
      diagnostics: receipt.redactedPayload ?? { redactedFields: [] },
    })),
    diagnostics: message.metadata,
  });
}

async function betterAuthSettings<Actor extends AuthorizationActor>(
  services: SmsOperationsRouteServices<Actor>,
  actor: Actor,
): Promise<BetterAuthVerificationDto> {
  if (services.betterAuth === undefined) {
    return { adapterStatus: "not_configured", loginTemplateKey: null, passwordResetTemplateKey: null };
  }
  return betterAuthVerificationDtoSchema.parse(await services.betterAuth.get(actor));
}

function verificationSettings(policy: object, betterAuth: BetterAuthVerificationDto) {
  return verificationSettingsDtoSchema.parse({
    ...policy,
    betterAuth,
  });
}

function parseDate(value: unknown, field: "from" | "to"): Date {
  if (typeof value !== "string") throw new HttpError(400, `invalid ${field}`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, `invalid ${field}`);
  return parsed;
}

function utcStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function isUtcDayStart(value: Date): boolean {
  return value.getUTCHours() === 0 && value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
}

function statsRange(query: Readonly<Record<string, unknown>>, clock: Clock | undefined): Readonly<{ from: Date; to: Date }> {
  const rawFrom = query.from;
  const rawTo = query.to;
  if ((rawFrom === undefined) !== (rawTo === undefined)) {
    throw new HttpError(400, "from and to must be supplied together");
  }
  if (rawFrom === undefined && rawTo === undefined) {
    const now = clock?.now() ?? new Date();
    if (Number.isNaN(now.getTime())) throw new SmsKitError("STORAGE_FAILURE", "clock is invalid", true);
    const today = utcStart(now);
    return { from: new Date(today.getTime() - 29 * DAY_MS), to: new Date(today.getTime() + DAY_MS) };
  }
  const from = parseDate(rawFrom, "from");
  const to = parseDate(rawTo, "to");
  // DailyStats is a UTC calendar-day aggregate. Refuse partial-day instants
  // instead of silently truncating a caller's requested range in PostgreSQL.
  if (!isUtcDayStart(from) || !isUtcDayStart(to)) {
    throw new HttpError(400, "statistics range must use UTC day boundaries");
  }
  const duration = to.getTime() - from.getTime();
  if (duration <= 0 || duration > MAX_STATS_RANGE_DAYS * DAY_MS) {
    throw new HttpError(400, "statistics range must be between one and 366 UTC days");
  }
  return { from, to };
}

/** Message timestamps retain instant precision, unlike daily statistics. */
function messageRange(query: Readonly<Record<string, unknown>>): Readonly<{ submittedFrom?: Date; submittedTo?: Date }> {
  const rawFrom = query.from;
  const rawTo = query.to;
  if ((rawFrom === undefined) !== (rawTo === undefined)) {
    throw new HttpError(400, "from and to must be supplied together");
  }
  if (rawFrom === undefined && rawTo === undefined) return {};
  const submittedFrom = parseDate(rawFrom, "from");
  const submittedTo = parseDate(rawTo, "to");
  const duration = submittedTo.getTime() - submittedFrom.getTime();
  if (duration <= 0 || duration > MAX_STATS_RANGE_DAYS * DAY_MS) {
    throw new HttpError(400, "message range must be between one instant and 366 days");
  }
  return { submittedFrom, submittedTo };
}

type CounterKey =
  | "submittedCount"
  | "acceptedCount"
  | "acceptanceRejectedCount"
  | "acceptanceUnknownCount"
  | "deliveryWaitingCount"
  | "deliveredCount"
  | "deliveryFailedCount"
  | "deliveryUnknownFinalCount"
  | "retryCount";

function asBigInt(value: number | string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SmsKitError("STORAGE_FAILURE", "statistics count is invalid", true);
    }
    return BigInt(value);
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new SmsKitError("STORAGE_FAILURE", "statistics count is invalid", true);
  }
  return BigInt(value);
}

function countDto(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function total(rows: readonly DailyStats[], key: CounterKey): number | string {
  let value = 0n;
  for (const row of rows) value += asBigInt(row[key]);
  return countDto(value);
}

function rate(numerator: number | string, denominator: number | string): number | undefined {
  const numeratorValue = asBigInt(numerator);
  const denominatorValue = asBigInt(denominator);
  if (denominatorValue === 0n) return undefined;
  // Keep arithmetic in bigint space, then return a bounded JSON number with
  // deterministic 12-decimal precision instead of rounding huge counts to 1.
  return Number((numeratorValue * RATE_SCALE) / denominatorValue) / Number(RATE_SCALE);
}

function statsDto(rows: readonly DailyStats[]) {
  const submitted = total(rows, "submittedCount");
  const accepted = total(rows, "acceptedCount");
  const delivered = total(rows, "deliveredCount");
  const acceptanceRate = rate(accepted, submitted);
  const deliveryRate = rate(delivered, accepted);
  return smsStatsDtoSchema.parse({
    submitted,
    accepted,
    acceptanceRejected: total(rows, "acceptanceRejectedCount"),
    acceptanceUnknown: total(rows, "acceptanceUnknownCount"),
    deliveryWaiting: total(rows, "deliveryWaitingCount"),
    delivered,
    deliveryFailed: total(rows, "deliveryFailedCount"),
    deliveryUnknownFinal: total(rows, "deliveryUnknownFinalCount"),
    retry: total(rows, "retryCount"),
    ...(acceptanceRate === undefined ? {} : { acceptanceRate }),
    ...(deliveryRate === undefined ? {} : { deliveryRate }),
  });
}

/**
 * Deferred job authorization is intentionally only a tenant-scoped metadata
 * lookup. It never returns a DTO, runs jobs, or reveals unowned worker jobs.
 */
export async function operationJobAuthorization(
  services: SmsOperationsRouteServices,
  input: Readonly<{ tenantId: AuthorizationActor["tenantId"]; jobId: string }>,
): Promise<OperationJobAuthorization | undefined> {
  const job = await requireService(services.store).jobs.get({ tenantId: input.tenantId, id: input.jobId });
  if (job?.originAction === "sms.test" || job?.originAction === "receipt.reconcile") {
    return { requiredPermission: job.originAction };
  }
  if (job === undefined) return undefined;
  return requireService(services.store).adminOperations.findJobAuthorization({
    tenantId: input.tenantId,
    jobId: input.jobId,
  });
}

/** Implements strict, tenant-scoped operational routes after router validation. */
export async function operationsRoute<Actor extends AuthorizationActor>(
  services: SmsOperationsRouteServices<Actor>,
  actor: Actor,
  path: string,
  body: unknown,
  params: Readonly<Record<string, string>>,
  query: Readonly<Record<string, unknown>>,
): Promise<unknown | undefined> {
  if (path === "/verification") {
    const policy = requireService(services.policy);
    if (body === undefined) {
      const [current, betterAuth] = await Promise.all([policy.get(actor), betterAuthSettings(services, actor)]);
      return verificationSettings(current, betterAuth);
    }
    const input = body as UpdateVerificationSettingsInput;
    // Validate the host-owned read model before the durable policy mutation so
    // an invalid adapter snapshot cannot turn a successful write into a 500.
    const betterAuth = await betterAuthSettings(services, actor);
    const updated = await policy.patch(actor, {
      expectedVersion: input.version,
      idempotencyKey: input.idempotencyKey,
      otpLength: input.otpLength,
      otpTtlSeconds: input.otpTtlSeconds,
      otpMaxAttempts: input.otpMaxAttempts,
      proofTtlSeconds: input.proofTtlSeconds,
      phoneMinIntervalSeconds: input.phoneMinIntervalSeconds,
      phoneHourlyLimit: input.phoneHourlyLimit,
      phoneDailyLimit: input.phoneDailyLimit,
      ipWindowSeconds: input.ipWindowSeconds,
      ipWindowLimit: input.ipWindowLimit,
      systemDailyBudget: input.systemDailyBudget,
      circuitOpen: input.circuitOpen,
      ...(input.circuitReason === undefined ? {} : { circuitReason: input.circuitReason }),
    });
    return verificationSettings(updated, betterAuth);
  }

  if (path === "/receipt-health") {
    const snapshot = await requireService(services.health).getSnapshot({ tenantId: actor.tenantId });
    return receiptHealthDtoSchema.parse({
      status: snapshot.status,
      ...(snapshot.lastReceiptAt === undefined ? {} : { lastReceiptAt: iso(snapshot.lastReceiptAt) }),
      pendingJobs: snapshot.pendingJobs,
      acceptanceUnknown: snapshot.acceptanceUnknown,
      deliveryUnknownFinal: snapshot.finalUnknown,
      unmatchedCount: snapshot.unmatchedReceipts,
      systemBudgetRemaining: snapshot.systemBudgetRemaining,
      circuitOpen: snapshot.circuitOpen,
      warnings: snapshot.warnings,
    });
  }

  if (path === "/reconcile") {
    const input = body as ReconcileInput;
    const result = await requireService(services.reconcile).enqueue(actor, {
      expectedVersion: input.version,
      idempotencyKey: input.idempotencyKey,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId as never }),
      ...(input.providerBizId === undefined ? {} : { providerBizId: input.providerBizId }),
    });
    if (result.kind === "not-found") throw new HttpError(404, "message not found");
    return jobDto(result.job);
  }

  if (path === "/messages") {
    const store = requireService(services.store);
    const range = messageRange(query);
    const phone = query.phone;
    let phoneHash: string | undefined;
    if (phone !== undefined) {
      if (typeof phone !== "string") throw new HttpError(400, "invalid phone");
      // The normalized one-off input is only held until the keyed lookup hash
      // is created; it is never attached to a DTO, query response, or store.
      phoneHash = await requireService(services.phoneProtector).lookupHash(normalizeMainlandPhone(phone));
    }
    const result = await store.messages.list({
      tenantId: actor.tenantId,
      page: query.page as number,
      pageSize: query.pageSize as number,
      ...range,
      ...(query.acceptanceStatus === undefined ? {} : { acceptanceStatus: query.acceptanceStatus as Message["acceptanceStatus"] }),
      ...(query.deliveryStatus === undefined ? {} : { deliveryStatus: query.deliveryStatus as Message["deliveryStatus"] }),
      ...(query.templateKey === undefined ? {} : { templateKey: query.templateKey as string }),
      ...(query.purpose === undefined ? {} : { purpose: query.purpose as string }),
      ...(phoneHash === undefined ? {} : { phoneHash }),
    });
    return messagePageDtoSchema.parse({
      items: await Promise.all(result.items.map((message) => messageProjection(store, message))),
      page: query.page,
      pageSize: query.pageSize,
      total: result.total,
    });
  }

  if (path === "/messages/:id") {
    const store = requireService(services.store);
    const message = await store.messages.get({ tenantId: actor.tenantId, id: params.id as never });
    if (message === undefined) throw new HttpError(404, "message not found");
    return messageDetailProjection(store, message);
  }

  if (path === "/stats") {
    const store = requireService(services.store);
    const range = statsRange(query, services.clock);
    const rows = await store.stats.query({
      tenantId: actor.tenantId,
      ...range,
      ...(query.templateKey === undefined ? {} : { templateKey: query.templateKey as string }),
      ...(query.purpose === undefined ? {} : { purpose: query.purpose as string }),
      ...(query.acceptanceStatus === undefined ? {} : { acceptanceStatus: query.acceptanceStatus as Message["acceptanceStatus"] }),
      ...(query.deliveryStatus === undefined ? {} : { deliveryStatus: query.deliveryStatus as Message["deliveryStatus"] }),
    });
    const templateKey = query.templateKey;
    const purpose = query.purpose;
    return statsDto(rows.filter((row) => row.tenantId === actor.tenantId &&
      (templateKey === undefined || row.templateKey === templateKey) &&
      (purpose === undefined || row.purpose === purpose)));
  }

  if (path === "/jobs/:id") {
    const job = await requireService(services.store).jobs.get({ tenantId: actor.tenantId, id: params.id! });
    if (job === undefined || await operationJobAuthorization(services, { tenantId: actor.tenantId, jobId: params.id! }) === undefined) {
      throw new HttpError(404, "job not found");
    }
    return jobDto(job);
  }

  return undefined;
}
