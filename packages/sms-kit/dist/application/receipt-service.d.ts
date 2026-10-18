import type { Clock, EventSink } from "../ports/runtime.js";
import type { SecretResolver } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";
declare const acknowledgement: Readonly<{
    code: 0;
    msg: "成功";
}>;
export type ReceiptServiceDependencies = Readonly<{
    store: SmsStore;
    secrets: SecretResolver;
    clock: Clock;
    events: EventSink;
    /** Reserve adapter response time; callbacks should fail retryably before it. */
    safetyMarginMs?: number;
}>;
export type ReceiptIngestInput = Readonly<{
    token: string;
    body: string | Uint8Array;
    deadlineAt: Date;
    /** Handler-owned cooperative cancellation for body/ingest deadline expiry. */
    signal?: AbortSignal;
}>;
export type ReceiptIngestResult = Readonly<{
    acknowledgement: typeof acknowledgement;
}>;
/**
 * Accepts an already HTTPS-terminated callback. Its possession token prevents
 * accidental traffic, but message ownership is proved only by the opaque
 * out_id and provider BizId pair stored at dispatch time.
 */
export declare class ReceiptService {
    private readonly dependencies;
    private readonly safetyMarginMs;
    constructor(dependencies: ReceiptServiceDependencies);
    ingest(input: ReceiptIngestInput): Promise<ReceiptIngestResult>;
}
export {};
