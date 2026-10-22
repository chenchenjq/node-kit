import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { SmsKitError, type SmsErrorCode } from "../../core/errors.js";
import type {
  SystemAuthChallenge,
  SystemAuthReconciliationLease,
  SystemAuthRepository,
} from "../../ports/system-auth.js";
import type { SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
type ChallengeRow = {
  id: string;
  idempotency_key: string;
  subject_id: string;
  action: SystemAuthChallenge["action"];
  phone_hash: string;
  code_hash: string;
  max_attempts: number;
  attempt_count: number;
  expires_at: Date;
  proof_ttl_seconds: number;
  delivery_acceptance_status: SystemAuthChallenge["deliveryAcceptanceStatus"];
  invalidated_at: Date | null;
  terminal_error_code: SmsErrorCode | null;
  verified_at: Date | null;
  proof_hash: string | null;
  proof_expires_at: Date | null;
};
const challengeFields =
  "id, idempotency_key, subject_id, action, phone_hash, code_hash, max_attempts, attempt_count, expires_at, proof_ttl_seconds, delivery_acceptance_status, invalidated_at, terminal_error_code, verified_at, proof_hash, proof_expires_at";

function db(pool: Pool, tx?: SmsTransaction): Queryable {
  return tx === undefined ? pool : (tx as PgSmsTransaction).client;
}

function challenge(row: ChallengeRow): SystemAuthChallenge {
  return {
    id: row.id as SystemAuthChallenge["id"],
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
export class PgSystemAuthRepository implements SystemAuthRepository {
  constructor(private readonly pool: Pool) {}

  async getChallengeByIdempotency(
    input: Parameters<SystemAuthRepository["getChallengeByIdempotency"]>[0],
    tx?: SmsTransaction,
  ): Promise<SystemAuthChallenge | undefined> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(
      `select ${challengeFields} from sms_kit.otp_challenge where scope_type = 'SYSTEM' and tenant_id is null and idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return rows[0] === undefined ? undefined : challenge(rows[0]);
  }

  async createChallenge(
    input: Parameters<SystemAuthRepository["createChallenge"]>[0],
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(
      `insert into sms_kit.otp_challenge (id, scope_type, tenant_id, idempotency_key, subject_id, action, purpose, policy_version, otp_length, otp_ttl_seconds, proof_ttl_seconds, phone_hash, code_hash, max_attempts, expires_at, created_at)
       values ($1, 'SYSTEM', null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now()) returning ${challengeFields}`,
      [
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
      ],
    );
    if (rows[0] === undefined)
      throw new SmsKitError(
        "STORAGE_FAILURE",
        "system authentication challenge could not be created",
        true,
      );
    return challenge(rows[0]);
  }

  async invalidateActiveChallenges(
    input: Parameters<SystemAuthRepository["invalidateActiveChallenges"]>[0],
    tx: SmsTransaction,
  ): Promise<void> {
    await db(this.pool, tx).query(
      `update sms_kit.otp_challenge set invalidated_at = $3, terminal_error_code = 'CHALLENGE_SUPERSEDED', delivery_acceptance_status = 'rejected'
        where scope_type = 'SYSTEM' and tenant_id is null and subject_id = $1 and action = $2
          and invalidated_at is null and consumed_at is null`,
      [input.subjectId, input.action, input.invalidatedAt],
    );
  }

  async getChallengeForUpdate(
    input: Parameters<SystemAuthRepository["getChallengeForUpdate"]>[0],
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge | undefined> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(
      `select ${challengeFields} from sms_kit.otp_challenge where scope_type = 'SYSTEM' and tenant_id is null and id = $1 for update`,
      [input.id],
    );
    return rows[0] === undefined ? undefined : challenge(rows[0]);
  }

  async incrementChallengeAttempts(
    input: Parameters<SystemAuthRepository["incrementChallengeAttempts"]>[0],
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(
      `update sms_kit.otp_challenge set attempt_count = attempt_count + 1 where scope_type = 'SYSTEM' and tenant_id is null and id = $1 returning ${challengeFields}`,
      [input.id],
    );
    if (rows[0] === undefined)
      throw new SmsKitError(
        "CONCURRENT_MODIFICATION",
        "system authentication challenge is no longer current",
      );
    return challenge(rows[0]);
  }

  async verifyChallenge(
    input: Parameters<SystemAuthRepository["verifyChallenge"]>[0],
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(
      `update sms_kit.otp_challenge set verified_at = $2, proof_hash = $3, proof_expires_at = $4 where scope_type = 'SYSTEM' and tenant_id is null and id = $1 and verified_at is null returning ${challengeFields}`,
      [input.id, input.verifiedAt, input.proofHash, input.proofExpiresAt],
    );
    if (rows[0] === undefined)
      throw new SmsKitError(
        "CONCURRENT_MODIFICATION",
        "system authentication challenge verification changed concurrently",
      );
    return challenge(rows[0]);
  }

  async consumeProof(
    input: Parameters<SystemAuthRepository["consumeProof"]>[0],
    tx: SmsTransaction,
  ): Promise<"consumed" | "replay" | "invalid"> {
    const client = db(this.pool, tx);
    const { rows } = await client.query<{
      consumed_at: Date | null;
      consumed_by_key: string | null;
      proof_expires_at: Date | null;
      invalidated_at: Date | null;
      verified_at: Date | null;
      delivery_acceptance_status: SystemAuthChallenge["deliveryAcceptanceStatus"];
    }>(
      `select consumed_at, consumed_by_key, proof_expires_at, invalidated_at, verified_at, delivery_acceptance_status
         from sms_kit.otp_challenge
        where scope_type = 'SYSTEM' and tenant_id is null and subject_id = $1 and action = $2 and proof_hash = $3
        for update`,
      [input.subjectId, input.action, input.proofHash],
    );
    const current = rows[0];
    if (
      current === undefined ||
      current.invalidated_at !== null ||
      current.verified_at === null ||
      current.delivery_acceptance_status !== "accepted" ||
      current.proof_expires_at === null ||
      current.proof_expires_at <= input.now
    )
      return "invalid";
    if (current.consumed_at !== null)
      return current.consumed_by_key === input.consumptionKey
        ? "replay"
        : "invalid";
    const result = await client.query(
      `update sms_kit.otp_challenge set consumed_at = $4, consumed_by_key = $5
        where scope_type = 'SYSTEM' and tenant_id is null and subject_id = $1 and action = $2 and proof_hash = $3 and consumed_at is null
          and invalidated_at is null and verified_at is not null and delivery_acceptance_status = 'accepted'`,
      [
        input.subjectId,
        input.action,
        input.proofHash,
        input.now,
        input.consumptionKey,
      ],
    );
    return result.rowCount === 1 ? "consumed" : "invalid";
  }

  async markChallengeDelivery(
    input: Parameters<SystemAuthRepository["markChallengeDelivery"]>[0],
    tx: SmsTransaction,
  ): Promise<SystemAuthChallenge> {
    const { rows } = await db(this.pool, tx).query<ChallengeRow>(
      `update sms_kit.otp_challenge set delivery_acceptance_status = $2, invalidated_at = coalesce($3, invalidated_at), terminal_error_code = coalesce($4, terminal_error_code) where scope_type = 'SYSTEM' and tenant_id is null and id = $1 and delivery_acceptance_status = 'pending' returning ${challengeFields}`,
      [
        input.id,
        input.status,
        input.invalidatedAt ?? null,
        input.terminalErrorCode ?? null,
      ],
    );
    if (rows[0] !== undefined) return challenge(rows[0]);
    const existing = await this.getChallengeForUpdate({ id: input.id }, tx);
    if (existing === undefined)
      throw new SmsKitError(
        "CONCURRENT_MODIFICATION",
        "system authentication challenge is no longer current",
      );
    return existing;
  }

  async createMessage(
    input: Parameters<SystemAuthRepository["createMessage"]>[0],
    tx: SmsTransaction,
  ): Promise<{
    id: import("../../core/types.js").MessageId;
    created: boolean;
  }> {
    const client = db(this.pool, tx);
    const inserted = await client.query<{ id: string }>(
      `insert into sms_kit.send_message (id, scope_type, tenant_id, idempotency_key, template_id, template_key_snapshot, external_template_code_snapshot, signature_name_snapshot, purpose, phone_ciphertext, phone_key_id, phone_hash, phone_last4, phone_masked, variable_names, metadata, acceptance_status, delivery_status, submitted_at, version, created_at, updated_at)
       values ($1, 'SYSTEM', null, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, '{"redactedFields":["phone","template-params"],"counts":[{"name":"message","value":1}]}'::jsonb, 'pending', 'not_applicable', $14, 1, now(), now())
       on conflict (scope_type, (coalesce(tenant_id, '')), idempotency_key) do nothing returning id`,
      [
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
      ],
    );
    if (inserted.rows[0] !== undefined)
      return {
        id: inserted.rows[0].id as import("../../core/types.js").MessageId,
        created: true,
      };
    const existing = await client.query<{ id: string }>(
      `select id from sms_kit.send_message where scope_type = 'SYSTEM' and tenant_id is null and idempotency_key = $1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0] === undefined)
      throw new SmsKitError(
        "STORAGE_FAILURE",
        "system authentication message could not be read",
        true,
      );
    return {
      id: existing.rows[0].id as import("../../core/types.js").MessageId,
      created: false,
    };
  }

  async startAttempt(
    input: Parameters<SystemAuthRepository["startAttempt"]>[0],
    tx: SmsTransaction,
  ): Promise<string> {
    const token = randomUUID();
    const result = await db(this.pool, tx).query(
      `insert into sms_kit.send_attempt
        (id, message_id, attempt_no, status, dispatch_mode, dispatch_token, dispatch_marked_at, occurred_at)
       select $2, m.id, 1, 'started', 'direct', $3, $4, $4
         from sms_kit.send_message m
        where m.id = $1 and m.scope_type = 'SYSTEM' and m.tenant_id is null and m.acceptance_status = 'pending'`,
      [input.messageId, randomUUID(), token, input.occurredAt],
    );
    if (result.rowCount !== 1)
      throw new SmsKitError(
        "CONCURRENT_MODIFICATION",
        "system authentication message is no longer pending",
      );
    return token;
  }

  async completeAttempt(
    input: Parameters<SystemAuthRepository["completeAttempt"]>[0],
    tx: SmsTransaction,
  ): Promise<void> {
    const result = await db(this.pool, tx).query(
      `update sms_kit.send_attempt a
          set status = $3, provider_request_id = $4, provider_code = $5,
              error_code = $6, occurred_at = $7
         from sms_kit.send_message m
        where a.message_id = m.id and m.id = $1 and m.scope_type = 'SYSTEM'
          and m.tenant_id is null and a.dispatch_token = $2 and a.status = 'started'`,
      [
        input.messageId,
        input.dispatchToken,
        input.status,
        input.providerRequestId ?? null,
        input.providerCode ?? null,
        input.errorCode ?? null,
        input.occurredAt,
      ],
    );
    if (result.rowCount !== 1)
      throw new SmsKitError(
        "CONCURRENT_MODIFICATION",
        "system authentication attempt is no longer current",
      );
  }

  async recoverAbandoned(
    input: Parameters<SystemAuthRepository["recoverAbandoned"]>[0],
    tx: SmsTransaction,
  ): Promise<number> {
    const { rows } = await db(this.pool, tx).query<{
      message_id: string;
      dispatch_token: string;
      challenge_id: string | null;
    }>(
      `select a.message_id, a.dispatch_token, c.id as challenge_id
         from sms_kit.send_attempt a
         join sms_kit.send_message m on m.id = a.message_id
         left join sms_kit.otp_challenge c
           on m.idempotency_key = 'system-auth:' || c.id::text
          and c.scope_type = 'SYSTEM' and c.tenant_id is null
        where m.scope_type = 'SYSTEM' and m.tenant_id is null
          and a.status = 'started' and a.dispatch_mode = 'direct'
          and a.dispatch_marked_at < $1
        order by a.dispatch_marked_at, a.id
        limit $2 for update of a skip locked`,
      [input.before, input.limit],
    );
    for (const row of rows) {
      if (row.challenge_id === null)
        throw new SmsKitError(
          "STORAGE_FAILURE",
          "system authentication attempt has no challenge",
          true,
        );
      const messageId = row.message_id as Parameters<SystemAuthRepository["completeAttempt"]>[0]["messageId"];
      await this.completeAttempt(
        {
          messageId,
          dispatchToken: row.dispatch_token,
          status: "unknown",
          occurredAt: input.occurredAt,
          errorCode: "ACCEPTANCE_UNKNOWN",
        },
        tx,
      );
      await this.markMessageAcceptance(
        {
          id: messageId,
          status: "unknown",
          occurredAt: input.occurredAt,
          errorCode: "ACCEPTANCE_UNKNOWN",
        },
        tx,
      );
      await this.markChallengeDelivery(
        {
          id: row.challenge_id as SystemAuthChallenge["id"],
          status: "unknown",
          invalidatedAt: input.occurredAt,
          terminalErrorCode: "ACCEPTANCE_UNKNOWN",
        },
        tx,
      );
      await this.scheduleReconciliation(
        { messageId, availableAt: input.occurredAt }, tx,
      );
      await db(this.pool, tx).query(
        `insert into sms_kit.audit_event
          (id, scope_type, tenant_id, actor_id, action, target_type, target_id, result, error_code, metadata, occurred_at)
         values ($1, 'SYSTEM', null, 'system-auth', 'auth.sms.recover', 'message', $2, 'failed', 'ACCEPTANCE_UNKNOWN', '{}'::jsonb, $3)`,
        [randomUUID(), messageId, input.occurredAt],
      );
    }
    return rows.length;
  }

  async applyReceipt(
    input: Parameters<SystemAuthRepository["applyReceipt"]>[0],
    tx: SmsTransaction,
  ): Promise<Readonly<{ matched: boolean; terminalConflict: boolean }>> {
    const client = db(this.pool, tx);
    const { rows } = await client.query<{
      id: string;
      acceptance_status: string;
      delivery_status: string;
    }>(
      `select id, acceptance_status, delivery_status from sms_kit.send_message
        where id::text = $1 and provider_biz_id = $2
          and scope_type = 'SYSTEM' and tenant_id is null for update`,
      [input.outId, input.bizId],
    );
    const message = rows[0];
    if (message === undefined) return { matched: false, terminalConflict: false };
    const inserted = await client.query(
      `insert into sms_kit.delivery_receipt
        (id, scope_type, tenant_id, message_id, match_status, dedupe_key, provider_biz_id,
         provider_out_id, delivery_status, provider_code, occurred_at, received_at, source, redacted_payload)
       values ($1, 'SYSTEM', null, $2, 'matched', $3, $4, $5, $6, $7, $8, $9, 'callback',
               '{"redactedFields":["phone"],"reportCount":1}'::jsonb)
       on conflict (dedupe_key) do nothing returning id`,
      [randomUUID(), message.id, input.dedupeKey, input.bizId, input.outId,
        input.status, input.providerCode, input.occurredAt, input.receivedAt],
    );
    if (inserted.rowCount === 0) {
      const promoted = await client.query(
        `update sms_kit.delivery_receipt
            set scope_type = 'SYSTEM', tenant_id = null, message_id = $2,
                match_status = 'matched', provider_out_id = $3
          where dedupe_key = $1 and match_status = 'unmatched'
            and provider_biz_id = $4 returning id`,
        [input.dedupeKey, message.id, input.outId, input.bizId],
      );
      if (promoted.rowCount === 0) {
        const existing = await client.query(
          `select id from sms_kit.delivery_receipt
            where dedupe_key = $1 and scope_type = 'SYSTEM' and tenant_id is null
              and message_id = $2 and match_status = 'matched'`,
          [input.dedupeKey, message.id],
        );
        if (existing.rowCount !== 1)
          throw new SmsKitError("CONCURRENT_MODIFICATION", "receipt belongs to another message");
        return { matched: true, terminalConflict: false };
      }
    }
    if (message.delivery_status !== "waiting" ||
        (message.acceptance_status !== "accepted" && message.acceptance_status !== "unknown"))
      return { matched: true, terminalConflict: true };
    await client.query(
      `update sms_kit.send_message
          set acceptance_status = 'accepted',
              accepted_at = coalesce(accepted_at, $2),
              delivery_status = $3,
              delivered_at = case when $3 = 'delivered' then $2 else delivered_at end,
              finalized_at = $2, version = version + 1, updated_at = now()
        where id = $1 and scope_type = 'SYSTEM' and tenant_id is null`,
      [message.id, input.occurredAt, input.status],
    );
    return { matched: true, terminalConflict: false };
  }

  async scheduleReconciliation(
    input: Parameters<SystemAuthRepository["scheduleReconciliation"]>[0],
    tx: SmsTransaction,
  ): Promise<void> {
    const result = await db(this.pool, tx).query(
      `insert into sms_kit.send_job
        (id, scope_type, tenant_id, dedupe_key, job_type, message_id, state,
         available_at, attempt_count, max_attempts, payload, created_at, updated_at)
       select $2, 'SYSTEM', null, 'reconcile:' || m.id::text, 'reconcile', m.id,
              'pending', $3, 0, 1, '{"kind":"reconcile"}'::jsonb, now(), now()
         from sms_kit.send_message m
        where m.id = $1 and m.scope_type = 'SYSTEM' and m.tenant_id is null
          and m.acceptance_status in ('accepted', 'unknown')
       on conflict (scope_type, (coalesce(tenant_id, '')), job_type, dedupe_key)
       do nothing`,
      [input.messageId, randomUUID(), input.availableAt],
    );
    if (result.rowCount === 1) return;
    const existing = await db(this.pool, tx).query(
      `select id from sms_kit.send_job
        where scope_type = 'SYSTEM' and tenant_id is null and job_type = 'reconcile'
          and dedupe_key = 'reconcile:' || $1::text and message_id = $1::uuid`,
      [input.messageId],
    );
    if (existing.rowCount !== 1)
      throw new SmsKitError("CONCURRENT_MODIFICATION", "system reconciliation job could not be scheduled");
  }

  async leaseReconciliation(
    input: Parameters<SystemAuthRepository["leaseReconciliation"]>[0],
  ): Promise<readonly SystemAuthReconciliationLease[]> {
    const { rows } = await this.pool.query<{
      job_id: string;
      lease_token: string;
      message_id: string;
      phone_ciphertext: string | null;
      phone_key_id: string | null;
      provider_biz_id: string | null;
      dispatch_marked_at: Date;
      delivery_status: SystemAuthReconciliationLease["deliveryStatus"];
    }>(
      `with candidate as (
         select j.id from sms_kit.send_job j
           join sms_kit.send_message m on m.id = j.message_id
           join sms_kit.send_attempt a on a.message_id = m.id and a.attempt_no = 1
          where j.scope_type = 'SYSTEM' and j.tenant_id is null
            and m.scope_type = 'SYSTEM' and m.tenant_id is null
            and j.job_type = 'reconcile'
            and m.delivery_status in ('waiting', 'delivered', 'failed', 'unknown_final')
            and m.acceptance_status in ('accepted', 'unknown')
            and a.status in ('accepted', 'unknown')
            and ((j.state = 'pending' and j.available_at <= $1)
              or (j.state = 'leased' and j.lease_until < $1))
          order by j.available_at, j.id
          limit $2 for update of j, m skip locked
       )
       update sms_kit.send_job j
          set state = 'leased', lease_owner = $3,
              lease_token = md5(random()::text || clock_timestamp()::text || j.id::text)::uuid,
              lease_generation = lease_generation + 1,
              lease_until = $1 + ($4 * interval '1 millisecond'), updated_at = now()
         from candidate c, sms_kit.send_message m, sms_kit.send_attempt a
        where j.id = c.id and m.id = j.message_id and a.message_id = m.id and a.attempt_no = 1
       returning j.id as job_id, j.lease_token, m.id as message_id,
                 m.phone_ciphertext, m.phone_key_id, m.provider_biz_id,
                 a.dispatch_marked_at, m.delivery_status`,
      [input.now, input.limit, input.owner, input.leaseMs],
    );
    return rows.map((row) => ({
      jobId: row.job_id,
      leaseToken: row.lease_token,
      messageId: row.message_id as SystemAuthReconciliationLease["messageId"],
      ...(row.phone_ciphertext === null ? {} : { phoneCiphertext: row.phone_ciphertext }),
      ...(row.phone_key_id === null ? {} : { phoneKeyId: row.phone_key_id }),
      ...(row.provider_biz_id === null ? {} : { providerBizId: row.provider_biz_id }),
      dispatchMarkedAt: row.dispatch_marked_at,
      deliveryStatus: row.delivery_status,
    }));
  }

  async finishTerminalReconciliation(
    input: Parameters<SystemAuthRepository["finishTerminalReconciliation"]>[0],
    tx: SmsTransaction,
  ): Promise<void> {
    const client = db(this.pool, tx);
    const completed = await client.query(
      `update sms_kit.send_job
          set state = 'succeeded', lease_owner = null, lease_token = null,
              lease_until = null, updated_at = now()
        where id = $1 and message_id = $2 and scope_type = 'SYSTEM' and tenant_id is null
          and job_type = 'reconcile' and state = 'leased' and lease_token = $3
          and lease_until > $4
          and exists (select 1 from sms_kit.send_message m where m.id = $2
            and m.scope_type = 'SYSTEM' and m.tenant_id is null
            and m.delivery_status in ('delivered', 'failed', 'unknown_final'))`,
      [input.lease.jobId, input.lease.messageId, input.lease.leaseToken, input.occurredAt],
    );
    if (completed.rowCount !== 1)
      throw new SmsKitError("CONCURRENT_MODIFICATION", "system reconciliation lease is no longer current");
  }

  async completeQueryReconciliation(
    input: Parameters<SystemAuthRepository["completeQueryReconciliation"]>[0],
    tx: SmsTransaction,
  ): Promise<void> {
    const client = db(this.pool, tx);
    const lease = await client.query(
      `select id from sms_kit.send_job
        where id = $1 and message_id = $2 and scope_type = 'SYSTEM' and tenant_id is null
          and job_type = 'reconcile' and state = 'leased' and lease_token = $3
          and lease_until > $4 for update`,
      [input.lease.jobId, input.lease.messageId, input.lease.leaseToken, input.receivedAt],
    );
    if (lease.rowCount !== 1)
      throw new SmsKitError("CONCURRENT_MODIFICATION", "system reconciliation lease is no longer current");
    const message = await client.query<{ delivery_status: string; acceptance_status: string }>(
      `select delivery_status, acceptance_status from sms_kit.send_message
        where id = $1 and scope_type = 'SYSTEM' and tenant_id is null for update`,
      [input.lease.messageId],
    );
    if (message.rows[0]?.delivery_status === "waiting" &&
        ["accepted", "unknown"].includes(message.rows[0].acceptance_status)) {
      await client.query(
        `insert into sms_kit.delivery_receipt
          (id, scope_type, tenant_id, message_id, match_status, dedupe_key, provider_biz_id,
           provider_out_id, delivery_status, provider_code, occurred_at, received_at, source, redacted_payload)
         values ($1, 'SYSTEM', null, $2::uuid, 'matched', $3, $4, $2::text, $5, $6, $7, $8,
                 'query', '{"redactedFields":["phone"],"reportCount":1}'::jsonb)
         on conflict (dedupe_key) do nothing`,
        [randomUUID(), input.lease.messageId, input.dedupeKey,
          input.lease.providerBizId ?? null, input.status, input.providerCode ?? null,
          input.occurredAt, input.receivedAt],
      );
      await client.query(
        `update sms_kit.send_message
            set acceptance_status = 'accepted', accepted_at = coalesce(accepted_at, $2),
                delivery_status = $3,
                delivered_at = case when $3 = 'delivered' then $2 else delivered_at end,
                finalized_at = $2, version = version + 1, updated_at = now()
          where id = $1 and scope_type = 'SYSTEM' and tenant_id is null`,
        [input.lease.messageId, input.occurredAt, input.status],
      );
    }
    const completed = await client.query(
      `update sms_kit.send_job set state = 'succeeded', lease_owner = null,
          lease_token = null, lease_until = null, updated_at = now()
        where id = $1 and scope_type = 'SYSTEM' and tenant_id is null
          and state = 'leased' and lease_token = $2`,
      [input.lease.jobId, input.lease.leaseToken],
    );
    if (completed.rowCount !== 1)
      throw new SmsKitError("CONCURRENT_MODIFICATION", "system reconciliation lease changed concurrently");
  }

  async rescheduleReconciliation(
    input: Parameters<SystemAuthRepository["rescheduleReconciliation"]>[0],
  ): Promise<void> {
    await this.pool.query(
      `update sms_kit.send_job
          set state = 'pending', available_at = $3, lease_owner = null, lease_token = null,
              lease_until = null, attempt_count = attempt_count + 1,
              last_error_code = $4, updated_at = now()
        where id = $1 and scope_type = 'SYSTEM' and tenant_id is null
          and state = 'leased' and lease_token = $2`,
      [input.lease.jobId, input.lease.leaseToken, input.availableAt, input.errorCode],
    );
  }

  async finalizeUnknownReconciliation(
    input: Parameters<SystemAuthRepository["finalizeUnknownReconciliation"]>[0],
    tx: SmsTransaction,
  ): Promise<void> {
    const client = db(this.pool, tx);
    const lease = await client.query(
      `select id from sms_kit.send_job
        where id = $1 and message_id = $2 and scope_type = 'SYSTEM' and tenant_id is null
          and job_type = 'reconcile' and state = 'leased' and lease_token = $3
          and lease_until > $4 for update`,
      [input.lease.jobId, input.lease.messageId, input.lease.leaseToken, input.occurredAt],
    );
    if (lease.rowCount !== 1)
      throw new SmsKitError("CONCURRENT_MODIFICATION", "system reconciliation lease is no longer current");
    await client.query(
      `update sms_kit.send_message
          set delivery_status = 'unknown_final', final_error_code = 'DELIVERY_UNKNOWN',
              finalized_at = $2, version = version + 1, updated_at = now()
        where id = $1 and scope_type = 'SYSTEM' and tenant_id is null
          and delivery_status = 'waiting'`,
      [input.lease.messageId, input.occurredAt],
    );
    const completed = await client.query(
      `update sms_kit.send_job
          set state = 'succeeded', lease_owner = null, lease_token = null,
              lease_until = null, updated_at = now()
        where id = $1 and scope_type = 'SYSTEM' and tenant_id is null
          and state = 'leased' and lease_token = $2`,
      [input.lease.jobId, input.lease.leaseToken],
    );
    if (completed.rowCount !== 1)
      throw new SmsKitError("CONCURRENT_MODIFICATION", "system reconciliation lease changed concurrently");
  }

  async markMessageAcceptance(
    input: Parameters<SystemAuthRepository["markMessageAcceptance"]>[0],
    tx: SmsTransaction,
  ): Promise<void> {
    const result = await db(this.pool, tx).query(
      `update sms_kit.send_message set acceptance_status = $2, delivery_status = case when $2 = 'rejected' then 'not_applicable' else 'waiting' end,
       provider_biz_id = coalesce($3, provider_biz_id), provider_request_id = coalesce($4, provider_request_id), final_error_code = coalesce($5, final_error_code),
       accepted_at = case when $2 = 'accepted' then $6 else accepted_at end, finalized_at = case when $2 = 'rejected' then $6 else finalized_at end,
       version = version + 1, updated_at = now() where scope_type = 'SYSTEM' and tenant_id is null and id = $1`,
      [
        input.id,
        input.status,
        input.providerBizId ?? null,
        input.providerRequestId ?? null,
        input.errorCode ?? null,
        input.occurredAt,
      ],
    );
    if (result.rowCount !== 1)
      throw new SmsKitError(
        "CONCURRENT_MODIFICATION",
        "system authentication message is no longer current",
      );
  }
}
