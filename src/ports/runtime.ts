import type { MessageId, TenantId } from "../core/types.js";

export type RedactedField = "phone" | "otp" | "proof" | "secret" | "template-params";
export type SafeMetricName = "attempt" | "job" | "message" | "receipt" | "resource" | "rate-limit";
/**
 * A deliberately non-extensible diagnostic shape. It describes redaction and
 * aggregate counts, never customer-provided values or arbitrary key/value data.
 */
export type SafeEventMetadata = Readonly<{
  redactedFields?: readonly RedactedField[];
  counts?: readonly Readonly<{ name: SafeMetricName; value: number }>[];
}>;

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
