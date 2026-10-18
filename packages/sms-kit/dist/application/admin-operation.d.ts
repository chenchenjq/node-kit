import type { SmsScope } from "../core/types.js";
import type { AdminOperationName, SmsStore, SmsTransaction } from "../ports/store.js";
type OperationInput<T> = Readonly<{
    store: SmsStore;
    scope: SmsScope;
    operation: AdminOperationName;
    idempotencyKey: string;
    request: unknown;
    decode(snapshot: Readonly<Record<string, unknown>>): T;
}>;
export declare function findAdminOperationReplay<T>(input: OperationInput<T>): Promise<T | undefined>;
export declare function executeAdminOperation<T>(input: OperationInput<T> & Readonly<{
    encode(result: T): Readonly<Record<string, unknown>>;
    work(tx: SmsTransaction): Promise<T>;
}>): Promise<Readonly<{
    value: T;
    replay: boolean;
}>>;
export {};
