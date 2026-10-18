import type { Pool } from "pg";
import type { MessageId } from "../../core/types.js";
import type { Job, JobOriginAction, JobRepository, SmsTransaction } from "../../ports/store.js";
export declare class PgJobRepository implements JobRepository {
    private readonly pool;
    constructor(pool: Pool);
    get(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
    }>, tx?: SmsTransaction): Promise<Job | undefined>;
    getForUpdate(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
    }>, tx: SmsTransaction): Promise<Job | undefined>;
    lease(input: Readonly<{
        tenantId?: Job["tenantId"];
        jobType?: Job["jobType"];
        owner: string;
        leaseMs: number;
        limit: number;
        now: Date;
    }>, tx?: SmsTransaction): Promise<readonly Job[]>;
    leaseReconciliation(input: Parameters<JobRepository["leaseReconciliation"]>[0], tx?: SmsTransaction): Promise<readonly Job[]>;
    renew(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
        leaseMs: number;
        now: Date;
    }>, tx?: SmsTransaction): Promise<Job>;
    reschedule(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
        availableAt: Date;
        errorCode?: string;
    }>, tx?: SmsTransaction): Promise<Job>;
    succeed(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
    }>, tx?: SmsTransaction): Promise<Job>;
    fail(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
        errorCode: string;
        terminal: boolean;
    }>, tx?: SmsTransaction): Promise<Job>;
    trySucceed(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
    }>, tx?: SmsTransaction): Promise<boolean>;
    trySucceedByLeaseToken(input: Readonly<{
        tenantId: Job["tenantId"];
        messageId: MessageId;
        leaseToken: string;
    }>, tx?: SmsTransaction): Promise<boolean>;
    tryReschedule(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
        availableAt: Date;
        errorCode?: string;
    }>, tx?: SmsTransaction): Promise<boolean>;
    tryFail(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
        errorCode: string;
        terminal: boolean;
    }>, tx?: SmsTransaction): Promise<boolean>;
    ensureReconcile(input: Readonly<{
        tenantId: Job["tenantId"];
        messageId: MessageId;
        availableAt: Date;
        originAction?: JobOriginAction;
    }>, tx?: SmsTransaction): Promise<Job>;
    lockExpiredSendJobs(input: Readonly<{
        before: Date;
        limit: number;
    }>, tx: SmsTransaction): Promise<readonly Job[]>;
    returnToPendingIfNoStarted(input: Readonly<{
        tenantId: Job["tenantId"];
        id: string;
        leaseToken: string;
    }>, tx: SmsTransaction): Promise<boolean>;
}
