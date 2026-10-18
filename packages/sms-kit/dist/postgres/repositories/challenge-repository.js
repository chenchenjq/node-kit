import { SmsKitError } from "../../core/errors.js";
const fields = "id, tenant_id, idempotency_key, subject_id, action, purpose, policy_version, otp_length, otp_ttl_seconds, proof_ttl_seconds, phone_hash, code_hash, attempt_count, max_attempts, expires_at, verified_at, proof_hash, proof_expires_at, delivery_acceptance_status, invalidated_at, terminal_error_code, consumed_at, consumed_by_key";
function db(pool, tx) {
    return tx === undefined ? pool : tx.client;
}
function challenge(row) {
    return {
        id: row.id, tenantId: row.tenant_id, idempotencyKey: row.idempotency_key,
        subjectId: row.subject_id, action: row.action, purpose: row.purpose, policyVersion: Number(row.policy_version), otpLength: row.otp_length, otpTtlSeconds: row.otp_ttl_seconds, proofTtlSeconds: row.proof_ttl_seconds,
        phoneHash: row.phone_hash, codeHash: row.code_hash,
        attemptCount: row.attempt_count, maxAttempts: row.max_attempts, expiresAt: row.expires_at,
        ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
        ...(row.proof_hash === null ? {} : { proofHash: row.proof_hash }),
        ...(row.proof_expires_at === null ? {} : { proofExpiresAt: row.proof_expires_at }),
        deliveryAcceptanceStatus: row.delivery_acceptance_status,
        ...(row.invalidated_at === null ? {} : { invalidatedAt: row.invalidated_at }),
        ...(row.terminal_error_code === null ? {} : { terminalErrorCode: row.terminal_error_code }),
    };
}
export class PgChallengeRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async create(input, tx) {
        const { rows } = await db(this.pool, tx).query(`insert into sms_kit.otp_challenge (id, tenant_id, idempotency_key, subject_id, action, purpose, policy_version, otp_length, otp_ttl_seconds, proof_ttl_seconds, phone_hash, code_hash, max_attempts, expires_at, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()) returning ${fields}`, [input.id, input.tenantId, input.idempotencyKey, input.subjectId, input.action, input.purpose, input.policyVersion, input.otpLength, input.otpTtlSeconds, input.proofTtlSeconds, input.phoneHash, input.codeHash, input.maxAttempts, input.expiresAt]);
        if (rows[0] === undefined)
            throw new SmsKitError("STORAGE_FAILURE", "challenge could not be created", true);
        return challenge(rows[0]);
    }
    async get(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.otp_challenge where tenant_id = $1 and id = $2`, [input.tenantId, input.id]);
        return rows[0] === undefined ? undefined : challenge(rows[0]);
    }
    async getByIdempotency(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.otp_challenge where tenant_id = $1 and idempotency_key = $2`, [input.tenantId, input.idempotencyKey]);
        return rows[0] === undefined ? undefined : challenge(rows[0]);
    }
    async invalidateActiveForSubjectAction(input, tx) {
        const result = await db(this.pool, tx).query(`update sms_kit.otp_challenge
          set invalidated_at = $4,
              terminal_error_code = 'CHALLENGE_SUPERSEDED',
              delivery_acceptance_status = 'rejected'
        where tenant_id = $1
          and subject_id = $2
          and action = $3
          and invalidated_at is null
          and consumed_at is null`, [input.tenantId, input.subjectId, input.action, input.invalidatedAt]);
        return result.rowCount ?? 0;
    }
    async getForUpdate(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${fields} from sms_kit.otp_challenge where tenant_id = $1 and id = $2 for update`, [input.tenantId, input.id]);
        return rows[0] === undefined ? undefined : challenge(rows[0]);
    }
    async incrementAttempts(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.otp_challenge set attempt_count = attempt_count + 1 where tenant_id = $1 and id = $2 returning ${fields}`, [input.tenantId, input.id]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "challenge is outside the trusted tenant");
        return challenge(rows[0]);
    }
    async verify(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.otp_challenge set verified_at = $3, proof_hash = $4, proof_expires_at = $5 where tenant_id = $1 and id = $2 and verified_at is null returning ${fields}`, [input.tenantId, input.id, input.verifiedAt, input.proofHash, input.proofExpiresAt]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "challenge verification changed concurrently");
        return challenge(rows[0]);
    }
    async markDeliveryAcceptance(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.otp_challenge set delivery_acceptance_status = $3 where tenant_id = $1 and id = $2 and delivery_acceptance_status = 'pending' returning ${fields}`, [input.tenantId, input.id, input.status]);
        if (rows[0] !== undefined)
            return challenge(rows[0]);
        const existing = await this.get({ tenantId: input.tenantId, id: input.id }, tx);
        if (existing === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "challenge is outside the trusted tenant");
        return existing;
    }
    async invalidate(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.otp_challenge set invalidated_at = $3, terminal_error_code = $4, delivery_acceptance_status = $5 where tenant_id = $1 and id = $2 and invalidated_at is null returning ${fields}`, [input.tenantId, input.id, input.invalidatedAt, input.terminalErrorCode, input.deliveryAcceptanceStatus]);
        if (rows[0] === undefined) {
            const existing = await this.get({ tenantId: input.tenantId, id: input.id }, tx);
            if (existing === undefined)
                throw new SmsKitError("CONCURRENT_MODIFICATION", "challenge is outside the trusted tenant");
            return existing;
        }
        return challenge(rows[0]);
    }
    async consumeProof(input, tx) {
        const client = db(this.pool, tx);
        const { rows } = await client.query(`select ${fields} from sms_kit.otp_challenge
        where tenant_id = $1 and proof_hash = $2
        for update`, [input.tenantId, input.proof]);
        const current = rows[0];
        if (current === undefined || current.subject_id !== input.subjectId || current.action !== input.action || current.verified_at === null || current.invalidated_at !== null || current.delivery_acceptance_status !== "accepted") {
            throw new SmsKitError("PROOF_INVALID", "proof is not valid for this subject and action");
        }
        const now = input.now();
        if (current.proof_expires_at === null || current.proof_expires_at <= now)
            return { consumed: false, reason: "expired" };
        if (current.consumed_at !== null) {
            return current.consumed_by_key === input.consumptionKey ? { consumed: true, replay: true } : { consumed: false, reason: "used" };
        }
        await client.query("update sms_kit.otp_challenge set consumed_at = $1, consumed_by_key = $2 where id = $3", [now, input.consumptionKey, current.id]);
        return { consumed: true, replay: false };
    }
}
