import type { Pool } from "pg";
import type { MessageId, TenantId } from "../../core/types.js";
import type { DeliveryReceipt, ReceiptRepository, SmsTransaction } from "../../ports/store.js";
export declare class PgReceiptRepository implements ReceiptRepository {
    private readonly pool;
    constructor(pool: Pool);
    record(input: Parameters<ReceiptRepository["record"]>[0], tx?: SmsTransaction): Promise<{
        receipt: DeliveryReceipt;
        created: boolean;
    }>;
    listForMessage(input: Readonly<{
        tenantId: TenantId;
        messageId: MessageId;
    }>, tx?: SmsTransaction): Promise<readonly DeliveryReceipt[]>;
}
