import type { AcceptanceStatus, DeliveryStatus } from "../core/status.js";
import type { ChallengeId, MessageId, TemplateId, TenantId } from "../core/types.js";
import type { PolicyStore } from "./policy.js";

/** Opaque transaction capability. Infrastructure adapters own external-client conversion. */
export interface SmsTransaction {
  readonly __smsKitTransaction: unique symbol;
}

export type ProviderConfigStatus = "unconfigured" | "untested" | "ready" | "degraded" | "disabled";

export type ProviderConfig = Readonly<{
  provider: "aliyun";
  region: string;
  endpoint?: string;
  accessKeyIdRef: string;
  accessKeySecretRef: string;
  receiptCallbackTokenRef: string;
  status: ProviderConfigStatus;
  enabled: boolean;
  lastTestStatus: "never" | "succeeded" | "failed";
  lastTestSummary?: Readonly<Record<string, string | number | boolean | null>>;
  lastTestedAt?: Date;
  version: number;
}>;

export type UpdateProviderConfigInput = Readonly<{
  provider: "aliyun";
  region: string;
  endpoint?: string;
  accessKeyIdRef: string;
  accessKeySecretRef: string;
  receiptCallbackTokenRef: string;
  enabled: boolean;
  expectedVersion: number;
}>;

export interface ConfigRepository {
  get(tx?: SmsTransaction): Promise<ProviderConfig>;
  update(input: UpdateProviderConfigInput, tx?: SmsTransaction): Promise<ProviderConfig>;
  recordConnectionTest(
    input: Readonly<{
      status: "succeeded" | "failed";
      summary: Readonly<Record<string, string | number | boolean | null>>;
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
export type ResourceSyncCandidate = Readonly<{
  id: string;
  resourceType: "signature" | "template";
  externalKey: string;
  changeType: "new" | "changed" | "unavailable" | "unchanged";
  checksum: string;
  snapshot: Readonly<Record<string, unknown>>;
}>;
export type ResourceSyncPreview = Readonly<{
  id: string;
  status: "running" | "succeeded" | "partial" | "failed";
  expiresAt: Date;
  candidates: readonly ResourceSyncCandidate[];
}>;

export interface ResourceRepository {
  listSignatures(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{
    items: readonly Signature[];
    total: number;
  }>;
  listTemplates(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{
    items: readonly Template[];
    total: number;
  }>;
  findTemplateByKey(input: Readonly<{ templateKey: string }>, tx?: SmsTransaction): Promise<Template | undefined>;
  createSyncPreview(input: Readonly<{
    id: string;
    actorId: string;
    expiresAt: Date;
    resources: readonly ResourceSyncCandidate[];
  }>, tx?: SmsTransaction): Promise<ResourceSyncPreview>;
  commitSync(input: Readonly<{
    syncId: string;
    candidates: readonly Readonly<{ id: string; checksum: string }>[];
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
  metadata: Readonly<Record<string, string | number | boolean | null>>;
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
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  submittedAt: Date;
  sendJob?: Readonly<{ id: string; dedupeKey: string; availableAt: Date; maxAttempts: number }>;
}>;
export type TenantMessageQuery = Readonly<{
  tenantId: TenantId;
  page: number;
  pageSize: number;
  acceptanceStatus?: AcceptanceStatus;
  deliveryStatus?: DeliveryStatus;
  templateKey?: string;
  phoneHash?: string;
}>;

export interface MessageRepository {
  createWithSendJob(input: CreateMessageInput, tx?: SmsTransaction): Promise<{ message: Message; created: boolean }>;
  get(input: Readonly<{ tenantId: TenantId; id: MessageId }>, tx?: SmsTransaction): Promise<Message | undefined>;
  list(input: TenantMessageQuery, tx?: SmsTransaction): Promise<{ items: readonly Message[]; total: number }>;
  findByProviderBizId(input: Readonly<{ bizId: string }>, tx?: SmsTransaction): Promise<Message | undefined>;
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
  }>, tx?: SmsTransaction): Promise<Attempt>;
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
  listExpiredStarted(input: Readonly<{ tenantId: TenantId; before: Date; limit: number }>, tx?: SmsTransaction): Promise<readonly Attempt[]>;
}

export type DeliveryReceipt = Readonly<{
  id: string;
  tenantId: TenantId;
  messageId?: MessageId;
  matchStatus: "matched" | "unmatched";
  dedupeKey: string;
  providerBizId: string;
  deliveryStatus: "delivered" | "failed";
  providerCode?: string;
  providerMessage?: string;
  occurredAt: Date;
  receivedAt: Date;
  source: "callback" | "query";
}>;
export interface ReceiptRepository {
  record(input: Readonly<{
    tenantId: TenantId;
    messageId?: MessageId;
    dedupeKey: string;
    providerBizId: string;
    deliveryStatus: "delivered" | "failed";
    providerCode?: string;
    providerMessage?: string;
    occurredAt: Date;
    receivedAt: Date;
    source: "callback" | "query";
    redactedPayload?: Readonly<Record<string, unknown>>;
  }>, tx?: SmsTransaction): Promise<{ receipt: DeliveryReceipt; created: boolean }>;
}

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
  payload: Readonly<Record<string, string | number | boolean | null>>;
}>;
export interface JobRepository {
  get(input: Readonly<{ tenantId: TenantId; id: string }>, tx?: SmsTransaction): Promise<Job | undefined>;
  lease(input: Readonly<{ tenantId: TenantId; owner: string; leaseMs: number; limit: number; now: Date }>, tx?: SmsTransaction): Promise<readonly Job[]>;
  renew(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; leaseMs: number; now: Date }>, tx?: SmsTransaction): Promise<Job>;
  reschedule(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; availableAt: Date; errorCode?: string }>, tx?: SmsTransaction): Promise<Job>;
  succeed(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string }>, tx?: SmsTransaction): Promise<Job>;
  fail(input: Readonly<{ tenantId: TenantId; id: string; leaseToken: string; errorCode: string; terminal: boolean }>, tx?: SmsTransaction): Promise<Job>;
}

export type Challenge = Readonly<{
  id: ChallengeId;
  tenantId: TenantId;
  subjectId: string;
  action: string;
  purpose: "password_change" | "step_up";
  phoneHash: string;
  codeHash: string;
  attemptCount: number;
  maxAttempts: number;
  expiresAt: Date;
  verifiedAt?: Date;
  proofExpiresAt?: Date;
}>;
export type ConsumeProofResult =
  | { consumed: true; replay: boolean }
  | { consumed: false; reason: "invalid" | "expired" | "used" };
export interface ChallengeRepository {
  create(input: Readonly<{
    id: ChallengeId;
    tenantId: TenantId;
    subjectId: string;
    action: string;
    purpose: "password_change" | "step_up";
    phoneHash: string;
    codeHash: string;
    maxAttempts: number;
    expiresAt: Date;
  }>, tx?: SmsTransaction): Promise<Challenge>;
  get(input: Readonly<{ tenantId: TenantId; id: ChallengeId }>, tx?: SmsTransaction): Promise<Challenge | undefined>;
  consumeProof(input: Readonly<{
    tenantId: TenantId;
    proof: string;
    subjectId: string;
    action: string;
    consumptionKey: string;
    now: Date;
  }>, tx: SmsTransaction): Promise<ConsumeProofResult>;
}

export interface RateLimitRepository {
  increment(input: Readonly<{
    tenantId: TenantId;
    scope: "phone_purpose" | "ip_purpose" | "global";
    scopeHash: string;
    windowStart: Date;
    windowSeconds: number;
    expiresAt: Date;
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
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
  occurredAt: Date;
}>;
export interface AuditRepository {
  append(input: AuditEvent, tx?: SmsTransaction): Promise<AuditEvent>;
  list(input: Readonly<{ tenantId: TenantId; page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{
    items: readonly AuditEvent[];
    total: number;
  }>;
}

export type DailyStats = Readonly<{
  tenantId: TenantId;
  statDate: string;
  templateKey: string;
  purpose: string;
  submittedCount: number;
  acceptedCount: number;
  acceptanceRejectedCount: number;
  acceptanceUnknownCount: number;
  deliveryWaitingCount: number;
  deliveredCount: number;
  deliveryFailedCount: number;
  deliveryUnknownFinalCount: number;
  retryCount: number;
}>;
export interface StatsRepository {
  query(input: Readonly<{ tenantId: TenantId; from: Date; to: Date }>, tx?: SmsTransaction): Promise<readonly DailyStats[]>;
  rollupDirtyDates(input: Readonly<{ limit: number }>, tx?: SmsTransaction): Promise<number>;
}

export interface SmsStore {
  transaction<T>(work: (tx: SmsTransaction) => Promise<T>): Promise<T>;
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
}
