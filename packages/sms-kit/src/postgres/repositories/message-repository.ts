import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import { assertAcceptanceTransition, assertDeliveryTransition } from "../../core/status.js";
import type { CreateMessageInput, Message, MessageRepository, SmsTransaction, TenantMessageQuery } from "../../ports/store.js";
import { projectSafeEventMetadata } from "../../ports/runtime.js";
import type { PgSmsTransaction } from "../transaction.js";
import { markMessageStatsDirty } from "./stats-repository.js";

type Queryable = Pool | PoolClient;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type MessageRow = {
  id: string; tenant_id: string; idempotency_key: string; template_id: string; template_key_snapshot: string;
  external_template_code_snapshot: string; signature_name_snapshot: string; purpose: string; phone_ciphertext: string | null;
  phone_key_id: string | null; phone_hash: string | null; phone_last4: string | null; phone_masked: string | null;
  variable_names: unknown; render_params_ciphertext: string | null; render_params_key_id: string | null; metadata: object;
  acceptance_status: Message["acceptanceStatus"]; delivery_status: Message["deliveryStatus"]; provider_biz_id: string | null;
  provider_request_id: string | null; final_error_code: string | null; submitted_at: Date; accepted_at: Date | null;
  delivered_at: Date | null; finalized_at: Date | null; version: string;
};

function queryable(pool: Pool, tx?: SmsTransaction): Queryable { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
async function transaction<T>(pool: Pool, tx: SmsTransaction | undefined, work: (db: Queryable) => Promise<T>): Promise<T> {
  if (tx !== undefined) return work(queryable(pool, tx));
  const client = await pool.connect();
  try { await client.query("begin"); const value = await work(client); await client.query("commit"); return value; }
  catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}
function message(row: MessageRow): Message {
  return {
    id: row.id as Message["id"], tenantId: row.tenant_id as Message["tenantId"], idempotencyKey: row.idempotency_key,
    templateId: row.template_id as Message["templateId"], templateKeySnapshot: row.template_key_snapshot,
    externalTemplateCodeSnapshot: row.external_template_code_snapshot, signatureNameSnapshot: row.signature_name_snapshot,
    purpose: row.purpose, ...(row.phone_ciphertext === null ? {} : { phoneCiphertext: row.phone_ciphertext }),
    ...(row.phone_key_id === null ? {} : { phoneKeyId: row.phone_key_id }), ...(row.phone_hash === null ? {} : { phoneHash: row.phone_hash }),
    ...(row.phone_last4 === null ? {} : { phoneLast4: row.phone_last4 }), ...(row.phone_masked === null ? {} : { phoneMasked: row.phone_masked }),
    variableNames: Array.isArray(row.variable_names) ? row.variable_names.filter((value): value is string => typeof value === "string") : [],
    ...(row.render_params_ciphertext === null ? {} : { renderParamsCiphertext: row.render_params_ciphertext }),
    ...(row.render_params_key_id === null ? {} : { renderParamsKeyId: row.render_params_key_id }), metadata: projectSafeEventMetadata(row.metadata),
    acceptanceStatus: row.acceptance_status, deliveryStatus: row.delivery_status,
    ...(row.provider_biz_id === null ? {} : { providerBizId: row.provider_biz_id }), ...(row.provider_request_id === null ? {} : { providerRequestId: row.provider_request_id }),
    ...(row.final_error_code === null ? {} : { finalErrorCode: row.final_error_code }), submittedAt: row.submitted_at,
    ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }), ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.finalized_at === null ? {} : { finalizedAt: row.finalized_at }), version: Number(row.version),
  };
}

/** PostgreSQL bigint counts are exposed without silently losing precision. */
function count(value: string): number | string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new SmsKitError("STORAGE_FAILURE", "message count is invalid", true);
  }
  const parsed = BigInt(value);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed.toString();
}
const selectMessage = "id, tenant_id, idempotency_key, template_id, template_key_snapshot, external_template_code_snapshot, signature_name_snapshot, purpose, phone_ciphertext, phone_key_id, phone_hash, phone_last4, phone_masked, variable_names, render_params_ciphertext, render_params_key_id, metadata, acceptance_status, delivery_status, provider_biz_id, provider_request_id, final_error_code, submitted_at, accepted_at, delivered_at, finalized_at, version";
const selectMessageFromJoin = selectMessage.split(", ").map((field) => `m.${field}`).join(", ");

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly pool: Pool) {}

  async rejectUndispatched(input: Parameters<MessageRepository["rejectUndispatched"]>[0], tx: SmsTransaction): Promise<void> {
    const db = queryable(this.pool, tx);
    const changed = await db.query(`update sms_kit.send_message m set acceptance_status = 'rejected', delivery_status = 'not_applicable', final_error_code = $3,
      finalized_at = $4, render_params_ciphertext = null, render_params_key_id = null, version = version + 1, updated_at = now()
      where tenant_id = $1 and id = $2 and acceptance_status = 'pending'
        and not exists (select 1 from sms_kit.send_attempt a where a.message_id = m.id and a.status <> 'rejected')`, [input.tenantId, input.id, input.errorCode, input.occurredAt]);
    if (changed.rowCount !== 1) throw new SmsKitError("CONCURRENT_MODIFICATION", "message cannot be rejected without dispatch evidence");
    await markMessageStatsDirty(db, input.tenantId, input.id);
  }

  async createWithSendJob(input: CreateMessageInput, tx?: SmsTransaction): Promise<{ message: Message; created: boolean }> {
    // Keep the public creation path aligned with the durable origin/job-type
    // check. JavaScript callers can bypass TypeScript's narrowed port type.
    const originAction: unknown = input.sendJob?.originAction;
    if (originAction !== undefined && originAction !== "sms.test") {
      throw new SmsKitError("CONFIG_INVALID", "send job origin is invalid");
    }
    return transaction(this.pool, tx, async (db) => {
      const inserted = await db.query<MessageRow>(
        `insert into sms_kit.send_message (id, tenant_id, idempotency_key, template_id, template_key_snapshot, external_template_code_snapshot, signature_name_snapshot, purpose, phone_ciphertext, phone_key_id, phone_hash, phone_last4, phone_masked, variable_names, render_params_ciphertext, render_params_key_id, metadata, acceptance_status, delivery_status, provider_biz_id, provider_request_id, final_error_code, submitted_at, accepted_at, delivered_at, finalized_at, version, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17::jsonb,'pending','not_applicable',null,null,null,$18,null,null,null,1,now(),now())
         on conflict (tenant_id, idempotency_key) do nothing returning ${selectMessage}`,
        [input.id, input.tenantId, input.idempotencyKey, input.templateId, input.templateKeySnapshot, input.externalTemplateCodeSnapshot,
          input.signatureNameSnapshot, input.purpose, input.phoneCiphertext, input.phoneKeyId, input.phoneHash, input.phoneLast4, input.phoneMasked,
          JSON.stringify(input.variableNames), input.renderParamsCiphertext ?? null, input.renderParamsKeyId ?? null, JSON.stringify(projectSafeEventMetadata(input.metadata)), input.submittedAt],
      );
      if (inserted.rows[0] === undefined) {
        const existing = await db.query<MessageRow>(`select ${selectMessage} from sms_kit.send_message where tenant_id = $1 and idempotency_key = $2`, [input.tenantId, input.idempotencyKey]);
        if (existing.rows[0] === undefined) throw new SmsKitError("STORAGE_FAILURE", "idempotent message could not be read", true);
        return { message: message(existing.rows[0]), created: false };
      }
      if (input.sendJob !== undefined) {
        const job = await db.query<{ id: string; message_id: string | null }>(
          `insert into sms_kit.send_job (id, tenant_id, dedupe_key, job_type, message_id, state, available_at, attempt_count, max_attempts, origin_action, payload, created_at, updated_at)
           values ($1, $2, $3, 'send', $4, 'pending', $5, 0, $6, $7, '{"kind":"none"}'::jsonb, now(), now())
           on conflict (tenant_id, job_type, dedupe_key) do nothing
           returning id, message_id`,
          [input.sendJob.id, input.tenantId, input.sendJob.dedupeKey, input.id, input.sendJob.availableAt, input.sendJob.maxAttempts, input.sendJob.originAction ?? null],
        );
        if (job.rows[0] === undefined) {
          const existing = await db.query<{ id: string; message_id: string | null }>("select id, message_id from sms_kit.send_job where tenant_id = $1 and job_type = 'send' and dedupe_key = $2 for update", [input.tenantId, input.sendJob.dedupeKey]);
          if (existing.rows[0]?.id !== input.sendJob.id || existing.rows[0].message_id !== input.id) {
            throw new SmsKitError("IDEMPOTENCY_CONFLICT", "send job dedupe key belongs to a different message");
          }
        }
      }
      await markMessageStatsDirty(db, input.tenantId, input.id);
      return { message: message(inserted.rows[0]), created: true };
    });
  }

  async get(input: Readonly<{ tenantId: Message["tenantId"]; id: Message["id"] }>, tx?: SmsTransaction): Promise<Message | undefined> {
    // PostgreSQL UUID casts must not turn a public missing-resource lookup
    // into a storage error. Other port implementations remain free to use
    // their own identifier representation.
    if (!uuidPattern.test(input.id)) return undefined;
    const { rows } = await queryable(this.pool, tx).query<MessageRow>(`select ${selectMessage} from sms_kit.send_message where tenant_id = $1 and id = $2${tx === undefined ? "" : " for update"}`, [input.tenantId, input.id]);
    return rows[0] === undefined ? undefined : message(rows[0]);
  }

  async lockByDispatchToken(input: Readonly<{ tenantId: Message["tenantId"]; dispatchToken: string }>, tx: SmsTransaction): Promise<Message | undefined> {
    const { rows } = await queryable(this.pool, tx).query<MessageRow>(
      `select ${selectMessageFromJoin} from sms_kit.send_message m
        join sms_kit.send_attempt a on a.message_id = m.id
       where m.tenant_id = $1 and a.dispatch_token = $2 for update of m, a`,
      [input.tenantId, input.dispatchToken],
    );
    return rows[0] === undefined ? undefined : message(rows[0]);
  }

  async list(input: TenantMessageQuery, tx?: SmsTransaction): Promise<{ items: readonly Message[]; total: number | string }> {
    const where = ["tenant_id = $1"];
    const values: unknown[] = [input.tenantId];
    const add = (condition: string, value: unknown) => { values.push(value); where.push(`${condition} $${values.length}`); };
    if (input.acceptanceStatus !== undefined) add("acceptance_status =", input.acceptanceStatus);
    if (input.deliveryStatus !== undefined) add("delivery_status =", input.deliveryStatus);
    if (input.templateKey !== undefined) add("template_key_snapshot =", input.templateKey);
    if (input.purpose !== undefined) add("purpose =", input.purpose);
    if (input.phoneHash !== undefined) add("phone_hash =", input.phoneHash);
    if (input.submittedFrom !== undefined) add("submitted_at >=", input.submittedFrom);
    if (input.submittedTo !== undefined) add("submitted_at <", input.submittedTo);
    const filter = where.join(" and ");
    const db = queryable(this.pool, tx);
    const countResult = await db.query<{ total: string }>(`select count(*)::text as total from sms_kit.send_message where ${filter}`, values);
    values.push(input.pageSize, (input.page - 1) * input.pageSize);
    const items = await db.query<MessageRow>(`select ${selectMessage} from sms_kit.send_message where ${filter} order by submitted_at desc, id desc limit $${values.length - 1} offset $${values.length}`, values);
    return { items: items.rows.map(message), total: count(countResult.rows[0]?.total ?? "0") };
  }

  async findByProviderBizId(input: Readonly<{ tenantId: Message["tenantId"]; bizId: string }>, tx?: SmsTransaction): Promise<Message | undefined> {
    const { rows } = await queryable(this.pool, tx).query<MessageRow>(`select ${selectMessage} from sms_kit.send_message where tenant_id = $1 and provider_biz_id = $2`, [input.tenantId, input.bizId]);
    return rows[0] === undefined ? undefined : message(rows[0]);
  }

  async lockByReceiptReference(input: Readonly<{ outId: string; bizId: string }>, tx: SmsTransaction): Promise<Message | undefined> {
    const { rows } = await queryable(this.pool, tx).query<MessageRow>(
      `select ${selectMessage} from sms_kit.send_message
        where id::text = $1 and provider_biz_id = $2 for update`,
      [input.outId, input.bizId],
    );
    return rows[0] === undefined ? undefined : message(rows[0]);
  }

  async completeAcceptance(input: Readonly<{ tenantId: Message["tenantId"]; dispatchToken: string; status: "accepted" | "rejected" | "unknown"; evidence: "same-dispatch-response" | "positive-provider-evidence" | "query-no-record"; providerBizId?: string; providerRequestId?: string; finalErrorCode?: string; occurredAt: Date }>, tx?: SmsTransaction): Promise<Message> {
    return transaction(this.pool, tx, async (db) => {
      const current = await db.query<MessageRow>(`select ${selectMessageFromJoin} from sms_kit.send_message m join sms_kit.send_attempt a on a.message_id = m.id where m.tenant_id = $1 and a.dispatch_token = $2 for update`, [input.tenantId, input.dispatchToken]);
      if (current.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "dispatch token is no longer current");
      assertAcceptanceTransition(current.rows[0].acceptance_status, input.status, input.evidence);
      const delivery = current.rows[0].delivery_status === "not_applicable"
        ? (input.status === "rejected" ? "not_applicable" : "waiting")
        : current.rows[0].delivery_status;
      const updated = await db.query<MessageRow>(`update sms_kit.send_message set acceptance_status = $1, delivery_status = $2, provider_biz_id = coalesce($3, provider_biz_id), provider_request_id = coalesce($4, provider_request_id), final_error_code = coalesce($5, final_error_code), accepted_at = case when $1 = 'accepted' then coalesce(accepted_at, $6) else accepted_at end, finalized_at = case when $1 = 'rejected' then $6 else finalized_at end, version = version + 1, updated_at = now() where tenant_id = $7 and id = $8 and acceptance_status = $9 returning ${selectMessage}`,
        [input.status, delivery, input.providerBizId ?? null, input.providerRequestId ?? null, input.finalErrorCode ?? null, input.occurredAt, input.tenantId, current.rows[0].id, current.rows[0].acceptance_status]);
      if (updated.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "message acceptance changed concurrently");
      await markMessageStatsDirty(db, input.tenantId, updated.rows[0].id);
      return message(updated.rows[0]);
    });
  }

  async completeDelivery(input: Readonly<{ tenantId: Message["tenantId"]; id: Message["id"]; status: "delivered" | "failed" | "unknown_final"; occurredAt: Date }>, tx?: SmsTransaction): Promise<Message> {
    return transaction(this.pool, tx, async (db) => {
      const current = await db.query<MessageRow>(`select ${selectMessage} from sms_kit.send_message where tenant_id = $1 and id = $2 for update`, [input.tenantId, input.id]);
      if (current.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "message is no longer current");
      assertDeliveryTransition(current.rows[0].delivery_status, input.status);
      const updated = await db.query<MessageRow>(`update sms_kit.send_message set delivery_status = $1, delivered_at = case when $1 = 'delivered' then $2 else delivered_at end, finalized_at = $2, version = version + 1, updated_at = now() where tenant_id = $3 and id = $4 and delivery_status = $5 returning ${selectMessage}`,
        [input.status, input.occurredAt, input.tenantId, input.id, current.rows[0].delivery_status]);
      if (updated.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "message delivery changed concurrently");
      await markMessageStatsDirty(db, input.tenantId, updated.rows[0].id);
      return message(updated.rows[0]);
    });
  }

  async completeQueryDelivery(input: Parameters<MessageRepository["completeQueryDelivery"]>[0], tx?: SmsTransaction): Promise<Message> {
    return transaction(this.pool, tx, async (db) => {
      const current = await db.query<MessageRow>(`select ${selectMessage} from sms_kit.send_message where tenant_id = $1 and id = $2 for update`, [input.tenantId, input.id]);
      const row = current.rows[0];
      if (row === undefined || row.delivery_status !== "waiting" || !["accepted", "unknown"].includes(row.acceptance_status)) {
        throw new SmsKitError("CONCURRENT_MODIFICATION", "message is no longer query-reconcilable");
      }
      const updated = await db.query<MessageRow>(`update sms_kit.send_message
        set acceptance_status = case when acceptance_status = 'unknown' then 'accepted' else acceptance_status end,
            accepted_at = case when acceptance_status = 'unknown' then coalesce(accepted_at, $1) else accepted_at end,
            delivery_status = $2, delivered_at = case when $2 = 'delivered' then $1 else delivered_at end,
            finalized_at = $1, version = version + 1, updated_at = now()
        where tenant_id = $3 and id = $4 and version = $5 returning ${selectMessage}`,
      [input.occurredAt, input.status, input.tenantId, input.id, row.version]);
      if (updated.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "message query reconciliation changed concurrently");
      await markMessageStatsDirty(db, input.tenantId, input.id);
      return message(updated.rows[0]);
    });
  }

  async clearRenderParams(input: Readonly<{ tenantId: Message["tenantId"]; id: Message["id"] }>, tx?: SmsTransaction): Promise<void> {
    await queryable(this.pool, tx).query("update sms_kit.send_message set render_params_ciphertext = null, render_params_key_id = null, version = version + 1, updated_at = now() where tenant_id = $1 and id = $2", [input.tenantId, input.id]);
  }
}
