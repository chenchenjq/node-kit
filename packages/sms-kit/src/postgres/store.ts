import type { Pool } from "pg";

import { SmsKitError } from "../core/errors.js";
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
import { asSmsTransaction } from "./transaction.js";

/** The repository subset backed by the first PostgreSQL persistence release. */
export class PgSmsStore {
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

  constructor(private readonly pool: Pool) {
    this.adminOperations = new PgAdminOperationRepository(pool);
    this.config = new PgConfigRepository(pool);
    this.resources = new PgResourceRepository(pool);
    this.messages = new PgMessageRepository(pool);
    this.attempts = new PgAttemptRepository(pool);
    this.receipts = new PgReceiptRepository(pool);
    this.jobs = new PgJobRepository(pool);
    this.policy = new PgPolicyStore(pool);
    this.challenges = new PgChallengeRepository(pool);
    this.rateLimits = new PgRateLimitRepository(pool);
    this.audits = new PgAuditRepository(pool);
    this.stats = new PgStatsRepository(pool);
    this.maintenance = new PgMaintenanceRepository(pool);
    this.health = new PgHealthRepository(pool);
  }

  async transaction<T>(work: (tx: SmsTransaction) => Promise<T>, options?: SmsTransactionOptions): Promise<T> {
    const assertActive = (): void => {
      if (options?.signal?.aborted === true) {
        throw new SmsKitError("STORAGE_FAILURE", "PostgreSQL transaction was aborted", true);
      }
    };
    assertActive();
    const client = await this.pool.connect();
    try {
      assertActive();
      await client.query("begin");
      assertActive();
      const result = await work(asSmsTransaction(client));
      // This is the final reversible boundary. No abort callback can run
      // between this synchronous check and handing COMMIT to node-postgres.
      assertActive();
      const commit = client.query("commit");
      // COMMIT cannot be reliably cancelled once dispatched. Do not race it
      // with the signal or issue a concurrent ROLLBACK on this client: wait for
      // the database outcome before releasing the connection. Receipt callers
      // absorb a timeout after this point through their semantic dedupe key.
      await commit;
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch { /* Preserve the original failure. */ }
      if (error instanceof SmsKitError) throw error;
      const causeCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
      throw new SmsKitError("STORAGE_FAILURE", "PostgreSQL transaction failed", true, undefined, causeCode);
    } finally {
      client.release();
    }
  }
}
