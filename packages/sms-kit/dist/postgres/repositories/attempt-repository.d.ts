import type { Pool } from "pg";
import type { Attempt, AttemptRepository, SmsTransaction } from "../../ports/store.js";
export declare class PgAttemptRepository implements AttemptRepository {
    private readonly pool;
    constructor(pool: Pool);
    countForMessage(input: Readonly<{
        tenantId: Attempt["tenantId"];
        messageId: Attempt["messageId"];
    }>, tx?: SmsTransaction): Promise<number | string>;
    listForMessage(input: Readonly<{
        tenantId: Attempt["tenantId"];
        messageId: Attempt["messageId"];
    }>, tx?: SmsTransaction): Promise<readonly Attempt[]>;
    createStarted(input: Readonly<{
        tenantId: Attempt["tenantId"];
        messageId: Attempt["messageId"];
        dispatchMode: "direct" | "queued";
        leaseToken?: string;
        dispatchMarkedAt: Date;
        minimumLeaseUntil?: Date;
    }>, tx?: SmsTransaction): Promise<Attempt>;
    lockByDispatchToken(input: Readonly<{
        tenantId: Attempt["tenantId"];
        dispatchToken: string;
    }>, tx: SmsTransaction): Promise<Attempt | undefined>;
    completeByDispatchToken(input: Readonly<{
        tenantId: Attempt["tenantId"];
        dispatchToken: string;
        status: "accepted" | "rejected" | "unknown";
        providerRequestId?: string;
        providerCode?: string;
        errorCode?: string;
        latencyMs?: number;
        occurredAt: Date;
    }>, tx?: SmsTransaction): Promise<Attempt>;
    listExpiredStarted(input: Readonly<{
        tenantId?: Attempt["tenantId"];
        before: Date;
        limit: number;
    }>, tx?: SmsTransaction): Promise<readonly Attempt[]>;
    listStartedForLeasedJobs(input: Readonly<{
        jobs: readonly Readonly<{
            tenantId: Attempt["tenantId"];
            id: string;
            leaseToken: string;
        }>[];
        limit: number;
    }>, tx: SmsTransaction): Promise<readonly Attempt[]>;
}
