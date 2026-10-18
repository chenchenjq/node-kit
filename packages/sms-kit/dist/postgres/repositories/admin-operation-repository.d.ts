import type { Pool } from "pg";
import { type SmsScope, type TenantId } from "../../core/types.js";
import type { AdminOperationClaim, AdminOperationName, AdminOperationRepository, SmsTransaction } from "../../ports/store.js";
export declare class PgAdminOperationRepository implements AdminOperationRepository {
    private readonly pool;
    constructor(pool: Pool);
    find(input: Readonly<{
        scope: SmsScope;
        operation: AdminOperationName;
        idempotencyKey: string;
        requestChecksum: string;
    }>, tx?: SmsTransaction): Promise<Readonly<Record<string, unknown>> | undefined>;
    claim(input: Readonly<{
        scope: SmsScope;
        operation: AdminOperationName;
        idempotencyKey: string;
        requestChecksum: string;
    }>, tx: SmsTransaction): Promise<AdminOperationClaim>;
    complete(input: Readonly<{
        scope: SmsScope;
        operation: AdminOperationName;
        idempotencyKey: string;
        requestChecksum: string;
        resultSnapshot: Readonly<Record<string, unknown>>;
    }>, tx: SmsTransaction): Promise<void>;
    authorizeJob(input: Readonly<{
        tenantId: TenantId;
        operation: "receipt.reconcile";
        idempotencyKey: string;
        jobId: string;
        requiredPermission: "receipt.reconcile";
    }>, tx: SmsTransaction): Promise<void>;
    findJobAuthorization(input: Readonly<{
        tenantId: TenantId;
        jobId: string;
    }>, tx?: SmsTransaction): Promise<Readonly<{
        requiredPermission: "receipt.reconcile";
    }> | undefined>;
}
