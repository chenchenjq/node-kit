import { SmsKitError, type SmsErrorCode } from "../core/errors.js";
import type { AcceptanceStatus, DeliveryStatus } from "../core/status.js";
import { validateTemplateKey } from "../core/template.js";
import type { ChallengeId, MessageId, TemplateId, TenantId } from "../core/types.js";
import type { PolicyStore } from "./policy.js";
import type { SafeEventMetadata, SafeReceiptPayload } from "./runtime.js";

/** Opaque transaction capability. Infrastructure adapters own external-client conversion. */
export interface SmsTransaction {
  readonly __smsKitTransaction: unique symbol;
}

export type SmsTransactionOptions = Readonly<{
  /**
   * Cooperative cancellation fence. Adapters must roll back when abort is
   * observed before commit dispatch; after that irreversible boundary they
   * must await the database outcome before reusing the connection.
   */
  signal?: AbortSignal;
}>;

export type AdminOperationName =
  | "config.patch"
  | "config.test_connection"
  | "resource.sync.preview"
  | "resource.sync.commit"
  | "signature.update"
  | "template.import"
  | "template.update"
  | "sms.test.send"
  | "policy.update"
  | "receipt.reconcile";

export type AdminOperationClaim =
  | Readonly<{ kind: "claimed" }>
  | Readonly<{ kind: "replay"; resultSnapshot: Readonly<Record<string, unknown>> }>;

/** Durable idempotency records are always claimed and completed inside one store transaction. */
export interface AdminOperationRepository {
  find(input: Readonly<{
    tenantId: TenantId;
    operation: AdminOperationName;
    idempotencyKey: string;
    requestChecksum: string;
  }>, tx?: SmsTransaction): Promise<Readonly<Record<string, unknown>> | undefined>;
  claim(input: Readonly<{
    tenantId: TenantId;
    operation: AdminOperationName;
    idempotencyKey: string;
    requestChecksum: string;
  }>, tx: SmsTransaction): Promise<AdminOperationClaim>;
  complete(input: Readonly<{
    tenantId: TenantId;
    operation: AdminOperationName;
    idempotencyKey: string;
    requestChecksum: string;
    resultSnapshot: Readonly<Record<string, unknown>>;
  }>, tx: SmsTransaction): Promise<void>;
  /**
   * Associates an existing system reconciliation job with the durable manual
   * operation that authorized it. This does not rewrite the job's origin.
   */
  authorizeJob(input: Readonly<{
    tenantId: TenantId;
    operation: "receipt.reconcile";
    idempotencyKey: string;
    jobId: string;
    requiredPermission: "receipt.reconcile";
  }>, tx: SmsTransaction): Promise<void>;
  findJobAuthorization(input: Readonly<{
    tenantId: TenantId;
    jobId: string;
  }>, tx?: SmsTransaction): Promise<Readonly<{ requiredPermission: "receipt.reconcile" }> | undefined>;
}

export type ProviderConfigStatus = "unconfigured" | "untested" | "ready" | "degraded" | "disabled";

export type UnconfiguredProviderConfig = Readonly<{
  provider: "aliyun";
  status: "unconfigured";
  enabled: false;
  lastTestStatus: "never";
  version: 0;
}>;
export type ConfiguredProviderConfig = Readonly<{
  provider: "aliyun";
  region: string;
  endpoint?: string;
  accessKeyIdRef: string;
  accessKeySecretRef: string;
  receiptCallbackTokenRef: string;
  status: Exclude<ProviderConfigStatus, "unconfigured">;
  enabled: boolean;
  lastTestStatus: "never" | "succeeded" | "failed";
  lastTestSummary?: SafeEventMetadata;
  lastTestedAt?: Date;
  version: number;
}>;
/** A pristine Store exposes an explicit singleton state without placeholder secret references. */
export type ProviderConfig = UnconfiguredProviderConfig | ConfiguredProviderConfig;

export type UpdateProviderConfigInput = Readonly<{
  provider: "aliyun";
  region: string;
  endpoint?: string;
  accessKeyIdRef: string;
  accessKeySecretRef: string;
  receiptCallbackTokenRef: string;
  enabled: boolean;
  expectedVersion: number;
  /** Credential changes are saved disabled until a new connection test succeeds. */
  resetReadiness?: boolean;
}>;

export interface ConfigRepository {
  get(tx?: SmsTransaction): Promise<ProviderConfig>;
  update(input: UpdateProviderConfigInput, tx?: SmsTransaction): Promise<ProviderConfig>;
  recordConnectionTest(
    input: Readonly<{
      status: "succeeded" | "failed";
      summary: SafeEventMetadata;
      testedAt: Date;
      expectedVersion: number;
    }>,
    tx?: SmsTransaction,
  ): Promise<ProviderConfig>;
}

export type ResourceVariable = Readonly<{ name: string; sensitive: boolean }>;
export type Signature = Readonly<{
  id: string;
  externalKey: string;
  externalName: string;
  externalStatus: string;
  externalType: string;
  enabled: boolean;
  version: number;
}>;
export type Template = Readonly<{
  id: TemplateId;
  signatureId: string;
  templateKey: string;
  externalCode: string;
  externalName: string;
  externalStatus: string;
  templateType: "verification" | "notification";
  purpose: string;
  variables: readonly ResourceVariable[];
  enabled: boolean;
  version: number;
}>;
export type UpdateSignatureResourceInput = Readonly<{
  id: string;
  enabled: boolean;
  expectedVersion: number;
}>;
export type ImportTemplateResourceInput = Readonly<{
  candidateId: string;
  checksum: string;
  templateKey: string;
  purpose: string;
  signatureExternalKey: string;
  expectedSignatureVersion: number;
  now: Date;
}>;
export type UpdateTemplateResourceInput = Readonly<{
  id: TemplateId;
  templateKey?: string;
  purpose?: string;
  enabled?: boolean;
  expectedVersion: number;
}>;
type ResourceSyncCandidateBase = Readonly<{
  id: string;
  externalKey: string;
  changeType: "new" | "changed" | "unavailable" | "unchanged";
  checksum: string;
}>;
declare const resourceSyncCandidateBrand: unique symbol;
export type SignatureResourceSnapshot = Readonly<{
  kind: "signature";
  externalName: string;
  externalStatus: string;
  externalType: string;
}>;
export type TemplateResourceSnapshot = Readonly<{
  kind: "template";
  externalCode: string;
  externalName: string;
  externalStatus: string;
  templateType: "verification" | "notification";
  variableNames: readonly string[];
}>;
export type TemplateResourceSelection = Readonly<{
  /** Stable local key selected by an administrator; never derived from provider identifiers. */
  templateKey: string;
  /** Local purpose selected by an administrator and preserved on later provider refreshes. */
  purpose: string;
  /** Provider signature identity used to resolve the template foreign key. */
  signatureExternalKey: string;
}>;
/** A finite provider-resource preview; it intentionally cannot carry arbitrary payload fields. */
export type ResourceSyncCandidate =
  | (ResourceSyncCandidateBase & Readonly<{
      resourceType: "signature";
      snapshot: SignatureResourceSnapshot;
    }> & { readonly [resourceSyncCandidateBrand]: true })
  | (ResourceSyncCandidateBase & Readonly<{
      resourceType: "template";
      snapshot: TemplateResourceSnapshot;
    }> & Readonly<Partial<TemplateResourceSelection>> & { readonly [resourceSyncCandidateBrand]: true });

export function hasTemplateResourceSelection(
  candidate: ResourceSyncCandidate,
): candidate is Extract<ResourceSyncCandidate, { resourceType: "template" }> & TemplateResourceSelection {
  return candidate.resourceType === "template" &&
    typeof candidate.signatureExternalKey === "string" &&
    typeof candidate.templateKey === "string" &&
    typeof candidate.purpose === "string";
}

function invalidResourceSyncCandidate(): never {
  throw new SmsKitError("CONFIG_INVALID", "invalid resource sync preview");
}

function requireObject(value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidResourceSyncCandidate();
  }
  return value;
}

function requireString(source: object, key: string): string {
  const value = Reflect.get(source, key);
  if (typeof value !== "string") return invalidResourceSyncCandidate();
  return value;
}

function requireEnum<T extends string>(source: object, key: string, allowed: readonly T[]): T {
  const value = Reflect.get(source, key);
  if (typeof value !== "string" || !allowed.includes(value as T)) return invalidResourceSyncCandidate();
  return value as T;
}

function requireStringArray(source: object, key: string): readonly string[] {
  const value = Reflect.get(source, key);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return invalidResourceSyncCandidate();
  }
  return Object.freeze([...value]);
}

function requireTemplateKey(source: object): string {
  const value = requireString(source, "templateKey");
  try {
    validateTemplateKey(value);
  } catch {
    return invalidResourceSyncCandidate();
  }
  return value;
}

/**
 * Enforces the resource-preview persistence boundary. This copies only the
 * allowed provider fields, discarding every extra property from an untrusted
 * SDK response before an adapter can persist it.
 */
export function createResourceSyncCandidate(input: unknown): ResourceSyncCandidate {
  const source = requireObject(input);
  const base = {
    id: requireString(source, "id"),
    externalKey: requireString(source, "externalKey"),
    changeType: requireEnum(source, "changeType", ["new", "changed", "unavailable", "unchanged"] as const),
    checksum: requireString(source, "checksum"),
  };
  const resourceType = requireEnum(source, "resourceType", ["signature", "template"] as const);
  const sourceSnapshot = requireObject(Reflect.get(source, "snapshot"));

  if (resourceType === "signature") {
    if (requireEnum(sourceSnapshot, "kind", ["signature"] as const) !== "signature") {
      return invalidResourceSyncCandidate();
    }
    const snapshot: SignatureResourceSnapshot = Object.freeze({
      kind: "signature",
      externalName: requireString(sourceSnapshot, "externalName"),
      externalStatus: requireString(sourceSnapshot, "externalStatus"),
      externalType: requireString(sourceSnapshot, "externalType"),
    });
    return Object.freeze({ ...base, resourceType, snapshot }) as ResourceSyncCandidate;
  }

  if (requireEnum(sourceSnapshot, "kind", ["template"] as const) !== "template") {
    return invalidResourceSyncCandidate();
  }
  const snapshot: TemplateResourceSnapshot = Object.freeze({
    kind: "template",
    externalCode: requireString(sourceSnapshot, "externalCode"),
    externalName: requireString(sourceSnapshot, "externalName"),
    externalStatus: requireString(sourceSnapshot, "externalStatus"),
    templateType: requireEnum(sourceSnapshot, "templateType", ["verification", "notification"] as const),
    variableNames: requireStringArray(sourceSnapshot, "variableNames"),
  });
  const hasSelection = ["signatureExternalKey", "templateKey", "purpose"]
    .some((key) => Reflect.get(source, key) !== undefined);
  if (!hasSelection) {
    return Object.freeze({ ...base, resourceType, snapshot }) as ResourceSyncCandidate;
  }
  return Object.freeze({
    ...base,
    resourceType,
    snapshot,
    signatureExternalKey: requireString(source, "signatureExternalKey"),
    templateKey: requireTemplateKey(source),
    purpose: requireString(source, "purpose"),
  }) as ResourceSyncCandidate;
}
export type ResourceSyncPreview = Readonly<{
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  expiresAt: Date;
  candidates: readonly ResourceSyncCandidate[];
}>;

export interface ResourceRepository {
  /** With a transaction, hold a shared row lock until dispatch eligibility has been committed. */
  findSignatureById(input: Readonly<{ id: string }>, tx?: SmsTransaction): Promise<Signature | undefined>;
  listSignatures(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{
    items: readonly Signature[];
    total: number;
  }>;
  listTemplates(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{
    items: readonly Template[];
    total: number;
  }>;
  /** With a transaction, hold a shared row lock until dispatch eligibility has been committed. */
  findTemplateByKey(input: Readonly<{ templateKey: string }>, tx?: SmsTransaction): Promise<Template | undefined>;
  /** Resource writes are always composed by an application-owned transaction. */
  updateSignature(input: UpdateSignatureResourceInput, tx: SmsTransaction): Promise<Signature>;
  /** Resource writes are always composed by an application-owned transaction. */
  importTemplate(input: ImportTemplateResourceInput, tx: SmsTransaction): Promise<Template>;
  /** Resource writes are always composed by an application-owned transaction. */
  updateTemplate(input: UpdateTemplateResourceInput, tx: SmsTransaction): Promise<Template>;
  createSyncPreview(input: Readonly<{
    id: string;
    actorId: string;
    expiresAt: Date;
    resources: readonly ResourceSyncCandidate[];
  }>, tx?: SmsTransaction): Promise<ResourceSyncPreview>;
  commitSync(input: Readonly<{
    syncId: string;
    candidates: readonly Readonly<{ id: string; checksum: string }>[];
    /** Supplied by the application clock so expiry fencing is deterministic. */
    now?: Date;
  }>, tx?: SmsTransaction): Promise<ResourceSyncPreview>;
}

export type Message = Readonly<{
  id: MessageId;
  tenantId: TenantId;
  idempotencyKey: string;
  templateId: TemplateId;
  templateKeySnapshot: string;
  externalTemplateCodeSnapshot: string;
  signatureNameSnapshot: string;
  purpose: string;
  phoneCiphertext?: string;
  phoneKeyId?: string;
  phoneHash?: string;
  phoneLast4?: string;
  phoneMasked?: string;
  variableNames: readonly string[];
  renderParamsCiphertext?: string;
  renderParamsKeyId?: string;
  metadata: SafeEventMetadata;
  acceptanceStatus: AcceptanceStatus;
  deliveryStatus: DeliveryStatus;
  providerBizId?: string;
  providerRequestId?: string;
  finalErrorCode?: string;
  submittedAt: Date;
  acceptedAt?: Date;
  deliveredAt?: Date;
  finalizedAt?: Date;
  version: number;
}>;
export type CreateMessageInput = Readonly<{
  id: MessageId;
  tenantId: TenantId;
  idempotencyKey: string;
  templateId: TemplateId;
  templateKeySnapshot: string;
  externalTemplateCodeSnapshot: string;
  signatureNameSnapshot: string;
  purpose: string;
  phoneCiphertext: string;
  phoneKeyId: string;
  phoneHash: string;
  phoneLast4: string;
  phoneMasked: string;
  variableNames: readonly string[];
  renderParamsCiphertext?: string;
  renderParamsKeyId?: string;
  metadata?: SafeEventMetadata;
  submittedAt: Date;
  sendJob?: Readonly<{
    id: string;
    dedupeKey: string;
    availableAt: Date;
    maxAttempts: number;
    /** A send job can only originate from the administrative test-send action. */
    originAction?: "sms.test";
  }>;
}>;
export type TenantMessageQuery = Readonly<{
  tenantId: TenantId;
  page: number;
  pageSize: number;
  submittedFrom?: Date;
  submittedTo?: Date;
  acceptanceStatus?: AcceptanceStatus;
  deliveryStatus?: DeliveryStatus;
  templateKey?: string;
  purpose?: string;
  phoneHash?: string;
}>;

export interface MessageRepository {
  /** Reject only pending work with no potentially accepted dispatch; caller owns the job lock. */
  rejectUndispatched(input: Readonly<{ tenantId: TenantId; id: MessageId; errorCode: string; occurredAt: Date }>, tx: SmsTransaction): Promise<void>;
  createWithSendJob(input: CreateMessageInput, tx?: SmsTransaction): Promise<{ message: Message; created: boolean }>;
  /** A transactional read locks the message against concurrent dispatch and retention. */
  get(input: Readonly<{ tenantId: TenantId; id: MessageId }>, tx?: SmsTransaction): Promise<Message | undefined>;
  /** Locks the message and its authoritative dispatch attempt together. */
  lockByDispatchToken(input: Readonly<{ tenantId: TenantId; dispatchToken: string }>, tx: SmsTransaction): Promise<Message | undefined>;
  list(input: TenantMessageQuery, tx?: SmsTransaction): Promise<{ items: readonly Message[]; total: number | string }>;
  findByProviderBizId(input: Readonly<{ tenantId: TenantId; bizId: string }>, tx?: SmsTransaction): Promise<Message | undefined>;
  /** Callback-only lookup: both opaque provider references must name one message. */
  lockByReceiptReference(input: Readonly<{ outId: string; bizId: string }>, tx: SmsTransaction): Promise<Message | undefined>;
  completeAcceptance(input: Readonly<{
    tenantId: TenantId;
    dispatchToken: string;
    status: Exclude<AcceptanceStatus, "pending">;
    evidence: "same-dispatch-response" | "positive-provider-evidence" | "query-no-record";
    providerBizId?: string;
    providerRequestId?: string;
    finalErrorCode?: string;
    occurredAt: Date;
  }>, tx?: SmsTransaction): Promise<Message>;
  completeDelivery(input: Readonly<{
    tenantId: TenantId;
    id: MessageId;
    status: Exclude<DeliveryStatus, "not_applicable" | "waiting">;
    occurredAt: Date;
  }>, tx?: SmsTransaction): Promise<Message>;
  /** Query evidence is correlated by this message's stored OutId before this atomic promotion. */
  completeQueryDelivery(input: Readonly<{
    tenantId: TenantId;
    id: MessageId;
    status: "delivered" | "failed";
    occurredAt: Date;
  }>, tx?: SmsTransaction): Promise<Message>;
  clearRenderParams(input: Readonly<{ tenantId: TenantId; id: MessageId }>, tx?: SmsTransaction): Promise<void>;
}

export type Attempt = Readonly<{
  id: string;
  tenantId: TenantId;
  messageId: MessageId;
  attemptNo: number;
  status: "started" | "accepted" | "rejected" | "unknown";
  dispatchMode: "direct" | "queued";
  dispatchToken: string;
  leaseToken?: string;
  dispatchMarkedAt: Date;
  providerRequestId?: string;
  providerCode?: string;
  errorCode?: string;
  latencyMs?: number;
  occurredAt: Date;
}>;
export interface AttemptRepository {
  createStarted(input: Readonly<{
    tenantId: TenantId;
    messageId: MessageId;
    dispatchMode: "direct" | "queued";
    leaseToken?: string;
    dispatchMarkedAt: Date;
    /** Queued work must retain this much lease before its irreversible marker. */
    minimumLeaseUntil?: Date;
  }>, tx?: SmsTransaction): Promise<Attempt>;
  lockByDispatchToken(input: Readonly<{ tenantId: TenantId; dispatchToken: string }>, tx: SmsTransaction): Promise<Attempt | undefined>;
  completeByDispatchToken(input: Readonly<{
    tenantId: TenantId;
    dispatchToken: string;
    status: "accepted" | "rejected" | "unknown";
    providerRequestId?: string;
    providerCode?: string;
    errorCode?: string;
    latencyMs?: number;
    occurredAt: Date;
  }>, tx?: SmsTransaction): Promise<Attempt>;
  /**
   * Lists started attempts that can no longer safely be dispatched. Direct
   * attempts use their marker deadline; queued attempts additionally require
   * their owning send-job lease to have expired. A background recovery worker
   * intentionally scans every tenant, while tenant-scoped callers can retain
   * their isolation by supplying tenantId.
   */
  listExpiredStarted(input: Readonly<{ tenantId?: TenantId; before: Date; limit: number }>, tx?: SmsTransaction): Promise<readonly Attempt[]>;
  /** Queued attempts may only be recovered through jobs already locked by this transaction. */
  listStartedForLeasedJobs(input: Readonly<{
    jobs: ReadonlyArray<Readonly<{ tenantId: TenantId; id: string; leaseToken: string }>>;
    limit: number;
  }>, tx: SmsTransaction): Promise<readonly Attempt[]>;
  /** Counts only attempts belonging to a message in the trusted tenant. */
  countForMessage(input: Readonly<{ tenantId: TenantId; messageId: MessageId }>, tx?: SmsTransaction): Promise<number | string>;
  /** Returns a tenant-scoped, chronological operational timeline. */
  listForMessage(input: Readonly<{ tenantId: TenantId; messageId: MessageId }>, tx?: SmsTransaction): Promise<readonly Attempt[]>;
}

export type DeliveryReceipt = Readonly<{
  id: string;
  /** Unmatched receipts are system-owned and therefore intentionally unscoped. */
  tenantId?: TenantId;
  messageId?: MessageId;
  matchStatus: "matched" | "unmatched";
  dedupeKey: string;
  providerBizId?: string;
  providerOutId?: string;
  deliveryStatus: "delivered" | "failed";
  providerCode?: string;
  providerMessage?: string;
  occurredAt: Date;
  receivedAt: Date;
  source: "callback" | "query";
  /** Finite diagnostic projection; raw callback payloads never cross this port. */
  redactedPayload?: SafeReceiptPayload;
}>;
export interface ReceiptRepository {
  record(input: Readonly<{
    tenantId: TenantId;
    messageId?: MessageId;
    dedupeKey: string;
    providerBizId?: string;
    providerOutId?: string;
    deliveryStatus: "delivered" | "failed";
    providerCode?: string;
    providerMessage?: string;
    occurredAt: Date;
    receivedAt: Date;
    source: "callback" | "query";
    redactedPayload?: SafeReceiptPayload;
  }>, tx?: SmsTransaction): Promise<{ receipt: DeliveryReceipt; created: boolean }>;
  /** Returns only matched receipts owned by the trusted tenant/message pair. */
  listForMessage(input: Readonly<{ tenantId: TenantId; messageId: MessageId }>, tx?: SmsTransaction): Promise<readonly DeliveryReceipt[]>;
}

/** Admin authority inherited by a job; absence means a system/ordinary-message origin with no direct admin read permission. */
export type JobOriginAction = "sms.test" | "receipt.reconcile";

export type Job = Readonly<{
  id: string;
  tenantId: TenantId;
  dedupeKey: string;
  jobType: "send" | "dispatch_recovery" | "reconcile" | "retention" | "rollup";
  messageId?: MessageId;
  state: "pending" | "leased" | "succeeded" | "failed" | "dead";
  availableAt: Date;
  leaseOwner?: string;
  leaseToken?: string;
  leaseGeneration: number;
  leaseUntil?: Date;
  attemptCount: number;
  maxAttempts: number;
  lastErrorCode?: string;
  /** Internal authorization metadata; never included in a public JobDto. */
  originAction?: JobOriginAction;
  payload: JobPayload;
}>;
export type JobPayload =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "reconcile"; providerBizId?: string }>
  | Readonly<{ kind: "retention"; before: Date }>
  | Readonly<{ kind: "rollup"; statDate?: string }>;
export interface JobRepository {
  get(input: Readonly<{ tenantId: TenantId; id: string }>, tx?: SmsTransaction): Promise<Job | undefined>;
  getForUpdate(input: Readonly<{ tenantId: TenantId; id: string }>, tx: SmsTransaction): Promise<Job | undefined>;
  lease(input: Readonly<{ tenantId?: TenantId; jobType?: Job["jobType"]; owner: string; leaseMs: number; limit: number; now: Date }>, tx?: SmsTransaction): Promise<readonly Job[]>;
  /** Leases tenant-owned queryable messages and terminal messages whose reconciliation jobs only need retirement. */
  leaseReconciliation(input: Readonly<{ owner: string; leaseMs: number; limit: number; now: Date }>, tx?: SmsTransaction): Promise<readonly Job[]>;
  renew(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; leaseMs: number; now: Date }>, tx?: SmsTransaction): Promise<Job>;
  reschedule(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; availableAt: Date; errorCode?: string }>, tx?: SmsTransaction): Promise<Job>;
  succeed(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string }>, tx?: SmsTransaction): Promise<Job>;
  fail(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; errorCode: string; terminal: boolean }>, tx?: SmsTransaction): Promise<Job>;
  /** Non-throwing fenced variants let a late provider response complete its attempt without taking over a new lease. */
  trySucceed(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string }>, tx?: SmsTransaction): Promise<boolean>;
  trySucceedByLeaseToken(input: Readonly<{ tenantId: TenantId; messageId: MessageId; leaseToken: string }>, tx?: SmsTransaction): Promise<boolean>;
  tryReschedule(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; availableAt: Date; errorCode?: string }>, tx?: SmsTransaction): Promise<boolean>;
  tryFail(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; errorCode: string; terminal: boolean }>, tx?: SmsTransaction): Promise<boolean>;
  /** Creates at most one reconciliation job per message; existing jobs are observed without taking an update lock. */
  ensureReconcile(input: Readonly<{
    tenantId: TenantId;
    messageId: MessageId;
    availableAt: Date;
    originAction?: JobOriginAction;
  }>, tx?: SmsTransaction): Promise<Job>;
  /** Locks expired send jobs before a separate fresh marker recheck. */
  lockExpiredSendJobs(input: Readonly<{ before: Date; limit: number }>, tx: SmsTransaction): Promise<readonly Job[]>;
  returnToPendingIfNoStarted(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string }>, tx: SmsTransaction): Promise<boolean>;
}

export type Challenge = Readonly<{
  id: ChallengeId;
  tenantId: TenantId;
  idempotencyKey: string;
  subjectId: string;
  action: string;
  purpose: "password_change" | "step_up";
  policyVersion: number;
  otpLength: number;
  otpTtlSeconds: number;
  proofTtlSeconds: number;
  phoneHash: string;
  codeHash: string;
  attemptCount: number;
  maxAttempts: number;
  expiresAt: Date;
  verifiedAt?: Date;
  proofHash?: string;
  proofExpiresAt?: Date;
  deliveryAcceptanceStatus: "pending" | "accepted" | "rejected" | "unknown";
  invalidatedAt?: Date;
  terminalErrorCode?: SmsErrorCode;
}>;
export type ConsumeProofResult =
  | { consumed: true; replay: boolean }
  | { consumed: false; reason: "invalid" | "expired" | "used" };
export interface ChallengeRepository {
  create(input: Readonly<{
    id: ChallengeId;
    tenantId: TenantId;
    idempotencyKey: string;
    subjectId: string;
    action: string;
    purpose: "password_change" | "step_up";
    policyVersion: number;
    otpLength: number;
    otpTtlSeconds: number;
    proofTtlSeconds: number;
    phoneHash: string;
    codeHash: string;
    maxAttempts: number;
    expiresAt: Date;
  }>, tx?: SmsTransaction): Promise<Challenge>;
  get(input: Readonly<{ tenantId: TenantId; id: ChallengeId }>, tx?: SmsTransaction): Promise<Challenge | undefined>;
  getByIdempotency(input: Readonly<{ tenantId: TenantId; idempotencyKey: string }>, tx?: SmsTransaction): Promise<Challenge | undefined>;
  getForUpdate(input: Readonly<{ tenantId: TenantId; id: ChallengeId }>, tx: SmsTransaction): Promise<Challenge | undefined>;
  incrementAttempts(input: Readonly<{ tenantId: TenantId; id: ChallengeId }>, tx: SmsTransaction): Promise<Challenge>;
  verify(input: Readonly<{
    tenantId: TenantId;
    id: ChallengeId;
    verifiedAt: Date;
    proofHash: string;
    proofExpiresAt: Date;
  }>, tx: SmsTransaction): Promise<Challenge>;
  markDeliveryAcceptance(input: Readonly<{
    tenantId: TenantId;
    id: ChallengeId;
    status: "accepted" | "rejected" | "unknown";
  }>, tx?: SmsTransaction): Promise<Challenge>;
  invalidate(input: Readonly<{
    tenantId: TenantId;
    id: ChallengeId;
    invalidatedAt: Date;
    terminalErrorCode: SmsErrorCode;
    deliveryAcceptanceStatus: "rejected" | "unknown";
  }>, tx?: SmsTransaction): Promise<Challenge>;
  consumeProof(input: Readonly<{
    tenantId: TenantId;
    proof: string;
    subjectId: string;
    action: string;
    consumptionKey: string;
    /** Evaluated while the challenge row is locked so lock waits cannot stale expiry checks. */
    now(): Date;
  }>, tx: SmsTransaction): Promise<ConsumeProofResult>;
}

export interface RateLimitRepository {
  /** Acquires a transaction-scoped stable lock for one tenant/phone/purpose policy stream. */
  lock(input: Readonly<{ tenantId: TenantId; scopeHash: string }>, tx: SmsTransaction): Promise<void>;
  increment(input: Readonly<{
    tenantId: TenantId;
    scope: "phone_purpose" | "ip_purpose" | "global";
    scopeHash: string;
    windowStart: Date;
    windowSeconds: number;
    expiresAt: Date;
  }>, tx?: SmsTransaction): Promise<number>;
  /** Counts recorded events after a boundary for transactional trailing windows. */
  countSince(input: Readonly<{
    tenantId: TenantId;
    scope: "phone_purpose" | "ip_purpose" | "global";
    scopeHash: string;
    since: Date;
  }>, tx?: SmsTransaction): Promise<number>;
}

export type AuditEvent = Readonly<{
  id: string;
  tenantId: TenantId;
  actorId: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: "succeeded" | "failed" | "denied";
  errorCode?: string;
  metadata?: SafeEventMetadata;
  occurredAt: Date;
}>;
export interface AuditRepository {
  append(input: AuditEvent, tx?: SmsTransaction): Promise<AuditEvent>;
  list(input: Readonly<{ tenantId: TenantId; page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{
    items: readonly AuditEvent[];
    total: number;
  }>;
}

/** JSON-safe nonnegative counter: a decimal string is used above JS-safe range. */
export type StatisticCount = number | string;

export type DailyStats = Readonly<{
  tenantId: TenantId;
  statDate: string;
  templateKey: string;
  purpose: string;
  submittedCount: StatisticCount;
  acceptedCount: StatisticCount;
  acceptanceRejectedCount: StatisticCount;
  acceptanceUnknownCount: StatisticCount;
  deliveryWaitingCount: StatisticCount;
  deliveredCount: StatisticCount;
  deliveryFailedCount: StatisticCount;
  deliveryUnknownFinalCount: StatisticCount;
  retryCount: StatisticCount;
}>;
export interface StatsRepository {
  /** Status filters select the exact acceptance/delivery intersection, never marginal daily counters. */
  query(input: Readonly<{
    tenantId: TenantId;
    from: Date;
    to: Date;
    templateKey?: string;
    purpose?: string;
    acceptanceStatus?: AcceptanceStatus;
    deliveryStatus?: DeliveryStatus;
  }>, tx?: SmsTransaction): Promise<readonly DailyStats[]>;
  /** Omitting tenantId lets the maintenance worker consume globally ordered dirty keys. */
  rollupDirtyDates(input: Readonly<{ tenantId?: TenantId; limit: number }>, tx?: SmsTransaction): Promise<number>;
}

export interface MaintenanceRepository {
  /** Applies only time-expired data lifecycle operations and returns affected rows. */
  applyRetention(input: Readonly<{
    now: Date;
    challengeBefore: Date;
    messagePhoneBefore: Date;
    receiptBefore: Date;
    auditBefore: Date;
    reservationBefore: Date;
    batchSize: number;
  }>, tx?: SmsTransaction): Promise<number>;
}

export type HealthCounts = Readonly<{
  usableTemplates?: StatisticCount;
  waitingMessages?: StatisticCount;
  oldestWaitingAt?: Date;
  oldestPendingJobAt?: Date;
  pendingJobs: StatisticCount;
  acceptanceUnknown: StatisticCount;
  finalUnknown: StatisticCount;
  /** System-owned receipts deliberately have no tenant/message details. */
  unmatchedReceipts: StatisticCount;
  heldBudgetCount?: StatisticCount;
  lastReceiptAt?: Date;
}>;
export interface HealthRepository {
  snapshot(input: Readonly<{ tenantId: TenantId; now: Date }>, tx?: SmsTransaction): Promise<HealthCounts>;
}

export interface SmsStore {
  transaction<T>(work: (tx: SmsTransaction) => Promise<T>, options?: SmsTransactionOptions): Promise<T>;
  adminOperations: AdminOperationRepository;
  config: ConfigRepository;
  resources: ResourceRepository;
  messages: MessageRepository;
  attempts: AttemptRepository;
  receipts: ReceiptRepository;
  jobs: JobRepository;
  challenges: ChallengeRepository;
  rateLimits: RateLimitRepository;
  policy: PolicyStore;
  audits: AuditRepository;
  stats: StatsRepository;
  maintenance: MaintenanceRepository;
  health: HealthRepository;
}
