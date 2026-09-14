import type { IdGenerator } from "../ports/runtime.js";

export const smsScheduledTaskNames = [
  "send-worker",
  "dispatch-recovery",
  "receipt-reconcile",
  "data-retention",
  "daily-rollup",
  "resource-sync",
] as const;

export type SmsScheduledTaskName = typeof smsScheduledTaskNames[number];

/** A host-bound task can receive only the bounded batch limit, never request payload or tenancy. */
export type SmsScheduledTask = Readonly<{
  runBatch(input: Readonly<{ limit: number }>): Promise<number>;
}>;

export type SmsTaskHandlerOptions = Readonly<{
  verifyScheduler(request: Request): boolean | Promise<boolean>;
  tasks: Readonly<Record<SmsScheduledTaskName, SmsScheduledTask>>;
  batchLimit: number;
  ids: Pick<IdGenerator, "next">;
}>;

const maximumBatchLimit = 1_000;
const taskNameSet = new Set<string>(smsScheduledTaskNames);

function error(status: number, message: string, requestId?: string): Response {
  return Response.json({ error: message, retryable: false, ...(requestId === undefined ? {} : { requestId }) }, { status });
}

function payloadPresent(request: Request): boolean {
  const length = request.headers.get("content-length");
  if (length === null) return request.body !== null;
  return !/^[0-9]+$/.test(length) || BigInt(length) !== 0n || request.body !== null;
}

function taskFrom(request: Request): SmsScheduledTaskName | undefined {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "task") return undefined;
  const value = entries[0][1];
  return taskNameSet.has(value) ? value as SmsScheduledTaskName : undefined;
}

/**
 * Creates a host-authenticated scheduler endpoint. Verification precedes all
 * request inspection, and task functions are prebound so callback input can
 * never select a tenant, actor, resource, or payload.
 */
export function createSmsTaskHandler(options: SmsTaskHandlerOptions) {
  if (!Number.isSafeInteger(options.batchLimit) || options.batchLimit < 1 || options.batchLimit > maximumBatchLimit) {
    throw new RangeError(`task batchLimit must be a positive safe integer no greater than ${maximumBatchLimit}`);
  }

  return async (request: Request): Promise<Response> => {
    try {
      if (!(await options.verifyScheduler(request))) return new Response(null, { status: 401 });
    } catch {
      return new Response(null, { status: 401 });
    }

    if (request.method !== "POST") return new Response(null, { status: 405 });
    const requestId = options.ids.next();
    if (payloadPresent(request)) return error(400, "invalid task request", requestId);
    const taskName = taskFrom(request);
    if (taskName === undefined) return error(400, "invalid task request", requestId);
    try {
      const processed = await options.tasks[taskName].runBatch({ limit: options.batchLimit });
      if (!Number.isSafeInteger(processed) || processed < 0) return error(500, "task failed", requestId);
      return Response.json({ data: processed, requestId });
    } catch {
      return error(500, "task failed", requestId);
    }
  };
}
