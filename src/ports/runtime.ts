import type { MainlandPhone } from "../core/phone.js";
import type { MessageId, TenantId } from "../core/types.js";

export type RedactedField = "phone" | "otp" | "proof" | "secret" | "template-params";
export type SafeMetricName = "attempt" | "job" | "message" | "receipt" | "resource" | "rate-limit" | "signature" | "template";
/**
 * A deliberately non-extensible diagnostic shape. It describes redaction and
 * aggregate counts, never customer-provided values or arbitrary key/value data.
 */
export type SafeEventMetadata = Readonly<{
  redactedFields?: readonly RedactedField[];
  counts?: readonly Readonly<{ name: SafeMetricName; value: number }>[];
}>;

export type SafeReceiptPayload = Readonly<{
  redactedFields: readonly RedactedField[];
  reportCount?: number;
}>;

const redactedFields = new Set<RedactedField>(["phone", "otp", "proof", "secret", "template-params"]);
const metricNames = new Set<SafeMetricName>(["attempt", "job", "message", "receipt", "resource", "rate-limit", "signature", "template"]);

/** Projects untrusted diagnostics to the finite persistence-safe metadata schema. */
export function projectSafeEventMetadata(input: unknown): SafeEventMetadata {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const safeFields = Array.isArray(source.redactedFields)
    ? source.redactedFields.filter((field): field is RedactedField => typeof field === "string" && redactedFields.has(field as RedactedField))
    : [];
  const safeCounts = Array.isArray(source.counts)
    ? source.counts.flatMap((count) => {
      if (typeof count !== "object" || count === null || Array.isArray(count)) return [];
      const value = count as Record<string, unknown>;
      return typeof value.name === "string" && metricNames.has(value.name as SafeMetricName) &&
        typeof value.value === "number" && Number.isFinite(value.value)
        ? [{ name: value.name as SafeMetricName, value: value.value }]
        : [];
    })
    : [];
  return {
    ...(safeFields.length === 0 ? {} : { redactedFields: safeFields }),
    ...(safeCounts.length === 0 ? {} : { counts: safeCounts }),
  };
}

/** Projects callback diagnostics before they enter JSONB, discarding nested or unknown values. */
export function projectSafeReceiptPayload(input: unknown): SafeReceiptPayload {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { redactedFields: [] };
  const source = input as Record<string, unknown>;
  const safeFields = Array.isArray(source.redactedFields)
    ? source.redactedFields.filter((field): field is RedactedField => typeof field === "string" && redactedFields.has(field as RedactedField))
    : [];
  const reportCount = typeof source.reportCount === "number" && Number.isFinite(source.reportCount) && source.reportCount >= 0
    ? source.reportCount
    : undefined;
  return { redactedFields: safeFields, ...(reportCount === undefined ? {} : { reportCount }) };
}

export interface TenantContext<Input = unknown> {
  /** Input is supplied by a trusted host-authentication boundary, never a request body. */
  resolve(input: Input): Promise<TenantId> | TenantId;
}

export class FixedTenantContext implements TenantContext<unknown> {
  constructor(private readonly tenantId: TenantId) {}

  resolve(_input: unknown): TenantId {
    return this.tenantId;
  }
}

export interface BackgroundTaskScheduler<Context = unknown> {
  schedule(task: () => Promise<void>, context: Context): void | Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export interface IdGenerator {
  next(): string;
  messageId(): MessageId;
}

export type SmsEvent = Readonly<{
  name: string;
  level?: "debug" | "info" | "warn" | "error";
  code?: string;
  tenantId?: TenantId;
  metadata?: SafeEventMetadata;
}>;

export interface EventSink {
  emit(event: SmsEvent): void | Promise<void>;
}

/**
 * Host-owned policy for the one recipient that an administrator may use when
 * exercising the SMS pipeline. The SMS kit never persists this policy or a
 * plaintext recipient; it asks the host only after normalizing the number.
 */
export interface TestRecipientAllowlist {
  allows(input: Readonly<{
    tenantId: TenantId;
    actorId: string;
    phone: MainlandPhone;
  }>): boolean | Promise<boolean>;
}
