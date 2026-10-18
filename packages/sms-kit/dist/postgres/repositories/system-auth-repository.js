import { SmsKitError } from "../../core/errors.js";
const challengeFields = "id, idempotency_key, subject_id, action, phone_hash, code_hash, max_attempts, attempt_count, expires_at, proof_ttl_seconds, delivery_acceptance_status, invalidated_at, terminal_error_code, verified_at, proof_hash, proof_expires_at";
function db(pool, tx) {
    return tx === undefined ? pool : tx.client;
}
function challenge(row) {
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        subjectId: row.subject_id,
        action: row.action,
        phoneHash: row.phone_hash,
        codeHash: row.code_hash,
        maxAttempts: row.max_attempts,
        attemptCount: row.attempt_count,
        expiresAt: row.expires_at,
        proofTtlSeconds: row.proof_ttl_seconds,
        deliveryAcceptanceStatus: row.delivery_acceptance_status,
        ...(row.invalidated_at === null
            ? {}
            : { invalidatedAt: row.invalidated_at }),
        ...(row.terminal_error_code === null
            ? {}
            : { terminalErrorCode: row.terminal_error_code }),
        ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
        ...(row.proof_hash === null ? {} : { proofHash: row.proof_hash }),
        ...(row.proof_expires_at === null
            ? {}
            : { proofExpiresAt: row.proof_expires_at }),
    };
}
/** Persistence boundary for singleton login and password-reset SMS only. */
export class PgSystemAuthRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async getChallengeByIdempotency(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${challengeFields} from sms_kit.otp_challenge where scope_type = 'SYSTEM' and tenant_id is null and idempotency_key = $1`, [input.idempotencyKey]);
        return rows[0] === undefined ? undefined : challenge(rows[0]);
    }
    async createChallenge(input, tx) {
        const { rows } = await db(this.pool, tx).query(`insert into sms_kit.otp_challenge (id, scope_type, tenant_id, idempotency_key, subject_id, action, purpose, policy_version, otp_length, otp_ttl_seconds, proof_ttl_seconds, phone_hash, code_hash, max_attempts, expires_at, created_at)
       values ($1, 'SYSTEM', null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now()) returning ${challengeFields}`, [
            input.id,
            input.idempotencyKey,
            input.subjectId,
            input.action,
            input.purpose,
            input.policyVersion,
            input.otpLength,
            input.otpTtlSeconds,
            input.proofTtlSeconds,
            input.phoneHash,
            input.codeHash,
            input.maxAttempts,
            input.expiresAt,
        ]);
        if (rows[0] === undefined)
            throw new SmsKitError("STORAGE_FAILURE", "system authentication challenge could not be created", true);
        return challenge(rows[0]);
    }
    async invalidateActiveChallenges(input, tx) {
        await db(this.pool, tx).query(`update sms_kit.otp_challenge set invalidated_at = $3, terminal_error_code = 'CHALLENGE_SUPERSEDED', delivery_acceptance_status = 'rejected'
        where scope_type = 'SYSTEM' and tenant_id is null and subject_id = $1 and action = $2
          and invalidated_at is null and consumed_at is null`, [input.subjectId, input.action, input.invalidatedAt]);
    }
    async getChallengeForUpdate(input, tx) {
        const { rows } = await db(this.pool, tx).query(`select ${challengeFields} from sms_kit.otp_challenge where scope_type = 'SYSTEM' and tenant_id is null and id = $1 for update`, [input.id]);
        return rows[0] === undefined ? undefined : challenge(rows[0]);
    }
    async incrementChallengeAttempts(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.otp_challenge set attempt_count = attempt_count + 1 where scope_type = 'SYSTEM' and tenant_id is null and id = $1 returning ${challengeFields}`, [input.id]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "system authentication challenge is no longer current");
        return challenge(rows[0]);
    }
    async verifyChallenge(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.otp_challenge set verified_at = $2, proof_hash = $3, proof_expires_at = $4 where scope_type = 'SYSTEM' and tenant_id is null and id = $1 and verified_at is null returning ${challengeFields}`, [input.id, input.verifiedAt, input.proofHash, input.proofExpiresAt]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "system authentication challenge verification changed concurrently");
        return challenge(rows[0]);
    }
    async consumeProof(input, tx) {
        const client = db(this.pool, tx);
        const { rows } = await client.query(`select consumed_at, consumed_by_key, proof_expires_at, invalidated_at, verified_at, delivery_acceptance_status
         from sms_kit.otp_challenge
        where scope_type = 'SYSTEM' and tenant_id is null and subject_id = $1 and action = $2 and proof_hash = $3
        for update`, [input.subjectId, input.action, input.proofHash]);
        const current = rows[0];
        if (current === undefined ||
            current.invalidated_at !== null ||
            current.verified_at === null ||
            current.delivery_acceptance_status !== "accepted" ||
            current.proof_expires_at === null ||
            current.proof_expires_at <= input.now)
            return "invalid";
        if (current.consumed_at !== null)
            return current.consumed_by_key === input.consumptionKey
                ? "replay"
                : "invalid";
        const result = await client.query(`update sms_kit.otp_challenge set consumed_at = $4, consumed_by_key = $5
        where scope_type = 'SYSTEM' and tenant_id is null and subject_id = $1 and action = $2 and proof_hash = $3 and consumed_at is null
          and invalidated_at is null and verified_at is not null and delivery_acceptance_status = 'accepted'`, [
            input.subjectId,
            input.action,
            input.proofHash,
            input.now,
            input.consumptionKey,
        ]);
        return result.rowCount === 1 ? "consumed" : "invalid";
    }
    async markChallengeDelivery(input, tx) {
        const { rows } = await db(this.pool, tx).query(`update sms_kit.otp_challenge set delivery_acceptance_status = $2, invalidated_at = coalesce($3, invalidated_at), terminal_error_code = coalesce($4, terminal_error_code) where scope_type = 'SYSTEM' and tenant_id is null and id = $1 and delivery_acceptance_status = 'pending' returning ${challengeFields}`, [
            input.id,
            input.status,
            input.invalidatedAt ?? null,
            input.terminalErrorCode ?? null,
        ]);
        if (rows[0] !== undefined)
            return challenge(rows[0]);
        const existing = await this.getChallengeForUpdate({ id: input.id }, tx);
        if (existing === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "system authentication challenge is no longer current");
        return existing;
    }
    async createMessage(input, tx) {
        const client = db(this.pool, tx);
        const inserted = await client.query(`insert into sms_kit.send_message (id, scope_type, tenant_id, idempotency_key, template_id, template_key_snapshot, external_template_code_snapshot, signature_name_snapshot, purpose, phone_ciphertext, phone_key_id, phone_hash, phone_last4, phone_masked, variable_names, metadata, acceptance_status, delivery_status, submitted_at, version, created_at, updated_at)
       values ($1, 'SYSTEM', null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, '{"redactedFields":["phone","template-params"],"counts":[{"name":"message","value":1}]}'::jsonb, 'pending', 'not_applicable', $14, 1, now(), now())
       on conflict (scope_type, (coalesce(tenant_id, '')), idempotency_key) do nothing returning id`, [
            input.id,
            input.idempotencyKey,
            input.templateId,
            input.templateKey,
            input.templateCode,
            input.signatureName,
            input.purpose,
            input.phoneCiphertext,
            input.phoneKeyId,
            input.phoneHash,
            input.phoneLast4,
            input.phoneMasked,
            JSON.stringify(input.variableNames),
            input.submittedAt,
        ]);
        if (inserted.rows[0] !== undefined)
            return {
                id: inserted.rows[0].id,
                created: true,
            };
        const existing = await client.query(`select id from sms_kit.send_message where scope_type = 'SYSTEM' and tenant_id is null and idempotency_key = $1`, [input.idempotencyKey]);
        if (existing.rows[0] === undefined)
            throw new SmsKitError("STORAGE_FAILURE", "system authentication message could not be read", true);
        return {
            id: existing.rows[0].id,
            created: false,
        };
    }
    async markMessageAcceptance(input, tx) {
        const result = await db(this.pool, tx).query(`update sms_kit.send_message set acceptance_status = $2, delivery_status = case when $2 = 'rejected' then 'not_applicable' else 'waiting' end,
       provider_biz_id = coalesce($3, provider_biz_id), provider_request_id = coalesce($4, provider_request_id), final_error_code = coalesce($5, final_error_code),
       accepted_at = case when $2 = 'accepted' then $6 else accepted_at end, finalized_at = case when $2 = 'rejected' then $6 else finalized_at end,
       version = version + 1, updated_at = now() where scope_type = 'SYSTEM' and tenant_id is null and id = $1`, [
            input.id,
            input.status,
            input.providerBizId ?? null,
            input.providerRequestId ?? null,
            input.errorCode ?? null,
            input.occurredAt,
        ]);
        if (result.rowCount !== 1)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "system authentication message is no longer current");
    }
}
