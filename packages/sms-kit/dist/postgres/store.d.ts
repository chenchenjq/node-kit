import type { Pool } from "pg";
import type { SmsTransaction, SmsTransactionOptions } from "../ports/store.js";
import { PgAttemptRepository } from "./repositories/attempt-repository.js";
import { PgAdminOperationRepository } from "./repositories/admin-operation-repository.js";
import { PgAuditRepository } from "./repositories/audit-repository.js";
import { PgChallengeRepository } from "./repositories/challenge-repository.js";
import { PgConfigRepository } from "./repositories/config-repository.js";
import { PgJobRepository } from "./repositories/job-repository.js";
import { PgHealthRepository } from "./repositories/health-repository.js";
import { PgMaintenanceRepository } from "./repositories/maintenance-repository.js";
import { PgMessageRepository } from "./repositories/message-repository.js";
import { PgPolicyStore } from "./repositories/policy-repository.js";
import { PgReceiptRepository } from "./repositories/receipt-repository.js";
import { PgResourceRepository } from "./repositories/resource-repository.js";
import { PgRateLimitRepository } from "./repositories/rate-limit-repository.js";
import { PgStatsRepository } from "./repositories/stats-repository.js";
import { PgSystemAuthRepository } from "./repositories/system-auth-repository.js";
/** The repository subset backed by the first PostgreSQL persistence release. */
export declare class PgSmsStore {
    private readonly pool;
    readonly adminOperations: PgAdminOperationRepository;
    readonly config: PgConfigRepository;
    readonly resources: PgResourceRepository;
    readonly messages: PgMessageRepository;
    readonly attempts: PgAttemptRepository;
    readonly receipts: PgReceiptRepository;
    readonly jobs: PgJobRepository;
    readonly policy: PgPolicyStore;
    readonly challenges: PgChallengeRepository;
    readonly rateLimits: PgRateLimitRepository;
    readonly audits: PgAuditRepository;
    readonly stats: PgStatsRepository;
    readonly maintenance: PgMaintenanceRepository;
    readonly health: PgHealthRepository;
    readonly systemAuth: PgSystemAuthRepository;
    constructor(pool: Pool);
    transaction<T>(work: (tx: SmsTransaction) => Promise<T>, options?: SmsTransactionOptions): Promise<T>;
}
