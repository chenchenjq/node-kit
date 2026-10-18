import type { Clock } from "../ports/runtime.js";
export type AliyunReceiptIngestor = Readonly<{
    ingest(input: Readonly<{
        token: string;
        body: string | Uint8Array;
        deadlineAt: Date;
        signal: AbortSignal;
    }>): Promise<unknown>;
}>;
export type AliyunReceiptHandlerOptions = Readonly<{
    receiptService: AliyunReceiptIngestor;
    clock: Clock;
    /**
     * The host authenticates the opaque path segment before this adapter reads
     * the request stream. ReceiptService repeats the check before persistence.
     */
    verifyToken(token: string): boolean | Promise<boolean>;
    maxBodyBytes?: number;
    safetyMarginMs?: number;
}>;
/**
 * Creates the public Alibaba callback boundary. The path token is checked
 * before a body stream is acquired; no callback field can select a tenant.
 */
export declare function createAliyunReceiptHandler(options: AliyunReceiptHandlerOptions): (request: Request) => Promise<Response>;
