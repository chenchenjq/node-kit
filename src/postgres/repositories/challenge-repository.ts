import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { Challenge, ChallengeRepository, ConsumeProofResult, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
type ChallengeRow = {
  id: string; tenant_id: string; subject_id: string; action: string; purpose: Challenge["purpose"];
  phone_hash: string; code_hash: string; attempt_count: number; max_attempts: number; expires_at: Date;
  verified_at: Date | null; proof_expires_at: Date | null; consumed_at: Date | null; consumed_by_key: string | null;
};
const fields = "id, tenant_id, subject_id, action, purpose, phone_hash, code_hash, attempt_count, max_attempts, expires_at, verified_at, proof_expires_at, consumed_at, consumed_by_key";

function db(pool: Pool, tx?: SmsTransaction): Queryable {
  return tx === undefined ? pool : (tx as PgSmsTransaction).client;
}

function challenge(row: ChallengeRow): Challenge {
  return {
    id: row.id as Challenge["id"], tenantId: row.tenant_id as Challenge["tenantId"], subjectId: row.subject_id,
    action: row.action, purpose: row.purpose, phoneHash: row.phone_hash, codeHash: row.code_hash,
    attemptCount: row.attempt_count, maxAttempts: row.max_attempts, expiresAt: row.expires_at,
    ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
    ...(row.proof_expires_at === null ? {} : { proofExpiresAt: row.proof_expires_at }),
  };
}

export class PgChallengeRepository implements ChallengeRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: Parameters<ChallengeRepository["create"]>[0], tx?: SmsTransaction): Promise<Challenge> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(
      `insert into sms_kit.otp_challenge (id, tenant_id, subject_id, action, purpose, phone_hash, code_hash, max_attempts, expires_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) returning ${fields}`,
      [input.id, input.tenantId, input.subjectId, input.action, input.purpose, input.phoneHash, input.codeHash, input.maxAttempts, input.expiresAt],
    );
    if (rows[0] === undefined) throw new SmsKitError("STORAGE_FAILURE", "challenge could not be created", true);
    return challenge(rows[0]);
  }

  async get(input: Parameters<ChallengeRepository["get"]>[0], tx?: SmsTransaction): Promise<Challenge | undefined> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(`select ${fields} from sms_kit.otp_challenge where tenant_id = $1 and id = $2`, [input.tenantId, input.id]);
    return rows[0] === undefined ? undefined : challenge(rows[0]);
  }

  async consumeProof(input: Parameters<ChallengeRepository["consumeProof"]>[0], tx: SmsTransaction): Promise<ConsumeProofResult> {
    const client = db(this.pool, tx);
    const { rows } = await client.query<ChallengeRow>(
      `select ${fields} from sms_kit.otp_challenge
        where tenant_id = $1 and proof_hash = $2
        for update`,
      [input.tenantId, input.proof],
    );
    const current = rows[0];
    if (current === undefined || current.subject_id !== input.subjectId || current.action !== input.action || current.verified_at === null) {
      throw new SmsKitError("PROOF_INVALID", "proof is not valid for this subject and action");
    }
    if (current.proof_expires_at === null || current.proof_expires_at <= input.now) return { consumed: false, reason: "expired" };
    if (current.consumed_at !== null) {
      return current.consumed_by_key === input.consumptionKey ? { consumed: true, replay: true } : { consumed: false, reason: "used" };
    }
    await client.query(
      "update sms_kit.otp_challenge set consumed_at = $1, consumed_by_key = $2 where id = $3",
      [input.now, input.consumptionKey, current.id],
    );
    return { consumed: true, replay: false };
  }
}
