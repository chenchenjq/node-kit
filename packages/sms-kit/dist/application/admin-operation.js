import { SmsKitError } from "../core/errors.js";
import { canonicalChecksum } from "./checksum.js";
function checksum(request) {
    try {
        return canonicalChecksum(request);
    }
    catch {
        throw new SmsKitError("CONFIG_INVALID", "admin operation input is invalid");
    }
}
function decoded(decode, snapshot) {
    try {
        return decode(snapshot);
    }
    catch (error) {
        if (error instanceof SmsKitError)
            throw error;
        throw new SmsKitError("STORAGE_FAILURE", "admin operation result is invalid", true);
    }
}
export async function findAdminOperationReplay(input) {
    const result = await input.store.adminOperations.find({
        scope: input.scope,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        requestChecksum: checksum(input.request),
    });
    return result === undefined ? undefined : decoded(input.decode, result);
}
export async function executeAdminOperation(input) {
    const requestChecksum = checksum(input.request);
    return input.store.transaction(async (tx) => {
        const claim = await input.store.adminOperations.claim({
            scope: input.scope,
            operation: input.operation,
            idempotencyKey: input.idempotencyKey,
            requestChecksum,
        }, tx);
        if (claim.kind === "replay")
            return { value: decoded(input.decode, claim.resultSnapshot), replay: true };
        const result = await input.work(tx);
        await input.store.adminOperations.complete({
            scope: input.scope,
            operation: input.operation,
            idempotencyKey: input.idempotencyKey,
            requestChecksum,
            resultSnapshot: input.encode(result),
        }, tx);
        return { value: result, replay: false };
    });
}
