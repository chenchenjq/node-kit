import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { MessageId, TenantId } from "../../core/types.js";
import type { DeliveryReceipt, ReceiptRepository, SmsTransaction } from "../../ports/store.js";
import { projectSafeReceiptPayload } from "../../ports/runtime.js";
import type { PgSmsTransaction } from "../transaction.js";

type Row = { id: string; tenant_id: string | null; message_id: string | null; match_status: DeliveryReceipt["matchStatus"]; dedupe_key: string; provider_biz_id: string | null; provider_out_id: string | null; delivery_status: DeliveryReceipt["deliveryStatus"]; provider_code: string | null; provider_message: string | null; occurred_at: Date; received_at: Date; source: DeliveryReceipt["source"]; redacted_payload: unknown };
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function receipt(row: Row): DeliveryReceipt { return { id: row.id, ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id as TenantId }), ...(row.message_id === null ? {} : { messageId: row.message_id as MessageId }), matchStatus: row.match_status, dedupeKey: row.dedupe_key, ...(row.provider_biz_id === null ? {} : { providerBizId: row.provider_biz_id }), ...(row.provider_out_id === null ? {} : { providerOutId: row.provider_out_id }), deliveryStatus: row.delivery_status, ...(row.provider_code === null ? {} : { providerCode: row.provider_code }), ...(row.provider_message === null ? {} : { providerMessage: row.provider_message }), occurredAt: row.occurred_at, receivedAt: row.received_at, source: row.source, redactedPayload: projectSafeReceiptPayload(row.redacted_payload) }; }
function unmatchedReceipt(input: Parameters<ReceiptRepository["record"]>[0]): DeliveryReceipt { return { id: randomUUID(), matchStatus: "unmatched", dedupeKey: input.dedupeKey, ...(input.providerBizId === undefined ? {} : { providerBizId: input.providerBizId }), ...(input.providerOutId === undefined ? {} : { providerOutId: input.providerOutId }), deliveryStatus: input.deliveryStatus, ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }), ...(input.providerMessage === undefined ? {} : { providerMessage: input.providerMessage }), occurredAt: input.occurredAt, receivedAt: input.receivedAt, source: input.source, ...(input.redactedPayload === undefined ? {} : { redactedPayload: projectSafeReceiptPayload(input.redactedPayload) }) }; }
const fields = "id, tenant_id, message_id, match_status, dedupe_key, provider_biz_id, provider_out_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source, redacted_payload";

export class PgReceiptRepository implements ReceiptRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: Parameters<ReceiptRepository["record"]>[0], tx?: SmsTransaction): Promise<{ receipt: DeliveryReceipt; created: boolean }> {
    const client = db(this.pool, tx);
    const redactedPayload = input.redactedPayload === undefined ? null : JSON.stringify(projectSafeReceiptPayload(input.redactedPayload));
    const inserted = input.messageId === undefined
      ? await client.query<Row>(`insert into sms_kit.delivery_receipt (id, tenant_id, message_id, match_status, dedupe_key, provider_biz_id, provider_out_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source, redacted_payload) values ($1, null, null, 'unmatched', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) on conflict (dedupe_key) do nothing returning ${fields}`,
        [randomUUID(), input.dedupeKey, input.providerBizId ?? null, input.providerOutId ?? null, input.deliveryStatus, input.providerCode ?? null, input.providerMessage ?? null, input.occurredAt, input.receivedAt, input.source, redactedPayload])
      : await client.query<Row>(`insert into sms_kit.delivery_receipt (id, tenant_id, message_id, match_status, dedupe_key, provider_biz_id, provider_out_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source, redacted_payload) select $1, m.tenant_id, m.id, 'matched', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb from sms_kit.send_message m where m.id = $12 and m.tenant_id = $13 on conflict (dedupe_key) do nothing returning ${fields}`,
        [randomUUID(), input.dedupeKey, input.providerBizId ?? null, input.providerOutId ?? null, input.deliveryStatus, input.providerCode ?? null, input.providerMessage ?? null, input.occurredAt, input.receivedAt, input.source, redactedPayload, input.messageId, input.tenantId]);
    if (inserted.rows[0] !== undefined) return { receipt: receipt(inserted.rows[0]), created: true };
    if (input.messageId === undefined) return { receipt: unmatchedReceipt(input), created: false };
    // A report can arrive before the accepted dispatch has persisted its
    // references. Once the exact opaque pair subsequently locks a message,
    // promote the system-owned row atomically instead of treating the shared
    // provider dedupe identity as a cross-tenant conflict.
    const promoted = await client.query<Row>(`update sms_kit.delivery_receipt receipt
      set tenant_id = message.tenant_id, message_id = message.id, match_status = 'matched'
      from sms_kit.send_message message
      where receipt.dedupe_key = $1 and receipt.match_status = 'unmatched'
        and message.id = $2 and message.tenant_id = $3
        and receipt.provider_biz_id = $4 and message.provider_biz_id = $4
      returning receipt.id, receipt.tenant_id, receipt.message_id, receipt.match_status, receipt.dedupe_key, receipt.provider_biz_id, receipt.provider_out_id, receipt.delivery_status, receipt.provider_code, receipt.provider_message, receipt.occurred_at, receipt.received_at, receipt.source, receipt.redacted_payload`,
    [input.dedupeKey, input.messageId, input.tenantId, input.providerBizId]);
    if (promoted.rows[0] !== undefined) return { receipt: receipt(promoted.rows[0]), created: true };
    const existing = await client.query<Row>(`select ${fields} from sms_kit.delivery_receipt where dedupe_key = $1 and tenant_id = $2 and message_id = $3`, [input.dedupeKey, input.tenantId, input.messageId]);
    if (existing.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "receipt belongs to a different tenant");
    return { receipt: receipt(existing.rows[0]), created: false };
  }

  async listForMessage(input: Readonly<{ tenantId: TenantId; messageId: MessageId }>, tx?: SmsTransaction): Promise<readonly DeliveryReceipt[]> {
    const { rows } = await db(this.pool, tx).query<Row>(
      `select r.id, r.tenant_id, r.message_id, r.match_status, r.dedupe_key,
              r.provider_biz_id, r.provider_out_id, r.delivery_status,
              r.provider_code, r.provider_message, r.occurred_at,
              r.received_at, r.source, r.redacted_payload
         from sms_kit.delivery_receipt r
         join sms_kit.send_message m on m.id = r.message_id and m.tenant_id = r.tenant_id
        where m.tenant_id = $1 and m.id = $2 and r.match_status = 'matched'
        order by r.occurred_at, r.received_at, r.id`,
      [input.tenantId, input.messageId],
    );
    return rows.map(receipt);
  }
}
