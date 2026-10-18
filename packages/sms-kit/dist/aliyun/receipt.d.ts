export declare const ALIYUN_RECEIPT_MAX_BODY_BYTES: number;
export declare const ALIYUN_RECEIPT_MAX_BATCH_ITEMS = 100;
export type AliyunReceipt = Readonly<{
    bizId: string;
    outId: string;
    occurredAt: Date;
    deliveryStatus: "delivered" | "failed";
    providerCode: string;
    providerMessage: string;
}>;
/**
 * Bounds and projects an untrusted Aliyun SmsReport HTTP JSON batch. The
 * callback telephone is deliberately used only for schema validation and is
 * never returned or made available to persistence callers.
 */
export declare function parseAliyunReceiptBatch(body: string | Uint8Array): readonly AliyunReceipt[];
