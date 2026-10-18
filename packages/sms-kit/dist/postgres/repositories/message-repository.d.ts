import type { Pool } from "pg";
import type { CreateMessageInput, Message, MessageRepository, SmsTransaction, TenantMessageQuery } from "../../ports/store.js";
export declare class PgMessageRepository implements MessageRepository {
    private readonly pool;
    constructor(pool: Pool);
    rejectUndispatched(input: Parameters<MessageRepository["rejectUndispatched"]>[0], tx: SmsTransaction): Promise<void>;
    createWithSendJob(input: CreateMessageInput, tx?: SmsTransaction): Promise<{
        message: Message;
        created: boolean;
    }>;
    get(input: Readonly<{
        tenantId: Message["tenantId"];
        id: Message["id"];
    }>, tx?: SmsTransaction): Promise<Message | undefined>;
    lockByDispatchToken(input: Readonly<{
        tenantId: Message["tenantId"];
        dispatchToken: string;
    }>, tx: SmsTransaction): Promise<Message | undefined>;
    list(input: TenantMessageQuery, tx?: SmsTransaction): Promise<{
        items: readonly Message[];
        total: number | string;
    }>;
    findByProviderBizId(input: Readonly<{
        tenantId: Message["tenantId"];
        bizId: string;
    }>, tx?: SmsTransaction): Promise<Message | undefined>;
    lockByReceiptReference(input: Readonly<{
        outId: string;
        bizId: string;
    }>, tx: SmsTransaction): Promise<Message | undefined>;
    completeAcceptance(input: Readonly<{
        tenantId: Message["tenantId"];
        dispatchToken: string;
        status: "accepted" | "rejected" | "unknown";
        evidence: "same-dispatch-response" | "positive-provider-evidence" | "query-no-record";
        providerBizId?: string;
        providerRequestId?: string;
        finalErrorCode?: string;
        occurredAt: Date;
    }>, tx?: SmsTransaction): Promise<Message>;
    completeDelivery(input: Readonly<{
        tenantId: Message["tenantId"];
        id: Message["id"];
        status: "delivered" | "failed" | "unknown_final";
        occurredAt: Date;
    }>, tx?: SmsTransaction): Promise<Message>;
    completeQueryDelivery(input: Parameters<MessageRepository["completeQueryDelivery"]>[0], tx?: SmsTransaction): Promise<Message>;
    clearRenderParams(input: Readonly<{
        tenantId: Message["tenantId"];
        id: Message["id"];
    }>, tx?: SmsTransaction): Promise<void>;
}
