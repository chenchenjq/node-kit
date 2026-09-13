import type { Pool } from "pg";

import { SmsKitError } from "../core/errors.js";
import type { SmsTransaction } from "../ports/store.js";
import { PgAttemptRepository } from "./repositories/attempt-repository.js";
import { PgAuditRepository } from "./repositories/audit-repository.js";
import { PgChallengeRepository } from "./repositories/challenge-repository.js";
import { PgConfigRepository } from "./repositories/config-repository.js";
import { PgJobRepository } from "./repositories/job-repository.js";
import { PgMessageRepository } from "./repositories/message-repository.js";
import { PgPolicyStore } from "./repositories/policy-repository.js";
import { PgReceiptRepository } from "./repositories/receipt-repository.js";
import { PgResourceRepository } from "./repositories/resource-repository.js";
import { PgRateLimitRepository } from "./repositories/rate-limit-repository.js";
import { PgStatsRepository } from "./repositories/stats-repository.js";
import { asSmsTransaction } from "./transaction.js";

/** The repository subset backed by the first PostgreSQL persistence release. */
export class PgSmsStore {
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

  constructor(private readonly pool: Pool) {
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
  }

  async transaction<T>(work: (tx: SmsTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await work(asSmsTransaction(client));
      await client.query("commit");
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
