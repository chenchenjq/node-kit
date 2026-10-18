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
    counts?: readonly Readonly<{
        name: SafeMetricName;
        value: number;
    }>[];
}>;
export type SafeReceiptPayload = Readonly<{
    redactedFields: readonly RedactedField[];
    reportCount?: number;
}>;
/** Projects untrusted diagnostics to the finite persistence-safe metadata schema. */
export declare function projectSafeEventMetadata(input: unknown): SafeEventMetadata;
/** Projects callback diagnostics before they enter JSONB, discarding nested or unknown values. */
export declare function projectSafeReceiptPayload(input: unknown): SafeReceiptPayload;
export interface TenantContext<Input = unknown> {
    /** Input is supplied by a trusted host-authentication boundary, never a request body. */
    resolve(input: Input): Promise<TenantId> | TenantId;
}
export declare class FixedTenantContext implements TenantContext<unknown> {
    private readonly tenantId;
    constructor(tenantId: TenantId);
    resolve(_input: unknown): TenantId;
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
