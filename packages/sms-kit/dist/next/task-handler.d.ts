import type { IdGenerator } from "../ports/runtime.js";
export declare const smsScheduledTaskNames: readonly ["send-worker", "dispatch-recovery", "receipt-reconcile", "data-retention", "daily-rollup", "resource-sync"];
export type SmsScheduledTaskName = typeof smsScheduledTaskNames[number];
/** A host-bound task can receive only the bounded batch limit, never request payload or tenancy. */
export type SmsScheduledTask = Readonly<{
    runBatch(input: Readonly<{
        limit: number;
    }>): Promise<number>;
}>;
export type SmsTaskHandlerOptions = Readonly<{
    verifyScheduler(request: Request): boolean | Promise<boolean>;
    tasks: Readonly<Record<SmsScheduledTaskName, SmsScheduledTask>>;
    batchLimit: number;
    ids: Pick<IdGenerator, "next">;
}>;
/**
 * Creates a host-authenticated scheduler endpoint. Verification precedes all
 * request inspection, and task functions are prebound so callback input can
 * never select a tenant, actor, resource, or payload.
 */
export declare function createSmsTaskHandler(options: SmsTaskHandlerOptions): (request: Request) => Promise<Response>;
