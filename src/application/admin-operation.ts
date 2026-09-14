import { SmsKitError } from "../core/errors.js";
import type { TenantId } from "../core/types.js";
import type { AdminOperationName, SmsStore, SmsTransaction } from "../ports/store.js";
import { canonicalChecksum } from "./checksum.js";

type OperationInput<T> = Readonly<{
  store: SmsStore;
  tenantId: TenantId;
  operation: AdminOperationName;
  idempotencyKey: string;
  request: unknown;
  decode(snapshot: Readonly<Record<string, unknown>>): T;
}>;

function checksum(request: unknown): string {
  try {
    return canonicalChecksum(request);
  } catch {
    throw new SmsKitError("CONFIG_INVALID", "admin operation input is invalid");
  }
}

function decoded<T>(
  decode: (snapshot: Readonly<Record<string, unknown>>) => T,
  snapshot: Readonly<Record<string, unknown>>,
): T {
  try {
    return decode(snapshot);
  } catch (error) {
    if (error instanceof SmsKitError) throw error;
    throw new SmsKitError("STORAGE_FAILURE", "admin operation result is invalid", true);
  }
}

export async function findAdminOperationReplay<T>(input: OperationInput<T>): Promise<T | undefined> {
  const result = await input.store.adminOperations.find({
    tenantId: input.tenantId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestChecksum: checksum(input.request),
  });
  return result === undefined ? undefined : decoded(input.decode, result);
}

export async function executeAdminOperation<T>(input: OperationInput<T> & Readonly<{
  encode(result: T): Readonly<Record<string, unknown>>;
  work(tx: SmsTransaction): Promise<T>;
}>): Promise<Readonly<{ value: T; replay: boolean }>> {
  const requestChecksum = checksum(input.request);
  return input.store.transaction(async (tx) => {
    const claim = await input.store.adminOperations.claim({
      tenantId: input.tenantId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestChecksum,
    }, tx);
    if (claim.kind === "replay") return { value: decoded(input.decode, claim.resultSnapshot), replay: true };
    const result = await input.work(tx);
    await input.store.adminOperations.complete({
      tenantId: input.tenantId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestChecksum,
      resultSnapshot: input.encode(result),
    }, tx);
    return { value: result, replay: false };
  });
}
