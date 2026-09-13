import type { MessageId, TenantId } from "../core/types.js";

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
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export interface EventSink {
  emit(event: SmsEvent): void | Promise<void>;
}
