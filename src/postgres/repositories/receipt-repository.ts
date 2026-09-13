import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { MessageId, TenantId } from "../../core/types.js";
import type { DeliveryReceipt, ReceiptRepository, SmsTransaction } from "../../ports/store.js";
import { projectSafeReceiptPayload } from "../../ports/runtime.js";
import type { PgSmsTransaction } from "../transaction.js";

type Row = { id: string; tenant_id: string | null; message_id: string | null; match_status: DeliveryReceipt["matchStatus"]; dedupe_key: string; provider_biz_id: string; delivery_status: DeliveryReceipt["deliveryStatus"]; provider_code: string | null; provider_message: string | null; occurred_at: Date; received_at: Date; source: DeliveryReceipt["source"] };
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function receipt(row: Row): DeliveryReceipt { return { id: row.id, ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id as TenantId }), ...(row.message_id === null ? {} : { messageId: row.message_id as MessageId }), matchStatus: row.match_status, dedupeKey: row.dedupe_key, providerBizId: row.provider_biz_id, deliveryStatus: row.delivery_status, ...(row.provider_code === null ? {} : { providerCode: row.provider_code }), ...(row.provider_message === null ? {} : { providerMessage: row.provider_message }), occurredAt: row.occurred_at, receivedAt: row.received_at, source: row.source }; }
function unmatchedReceipt(input: Parameters<ReceiptRepository["record"]>[0]): DeliveryReceipt { return { id: randomUUID(), matchStatus: "unmatched", dedupeKey: input.dedupeKey, providerBizId: input.providerBizId, deliveryStatus: input.deliveryStatus, ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }), ...(input.providerMessage === undefined ? {} : { providerMessage: input.providerMessage }), occurredAt: input.occurredAt, receivedAt: input.receivedAt, source: input.source }; }
const fields = "id, tenant_id, message_id, match_status, dedupe_key, provider_biz_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source";

export class PgReceiptRepository implements ReceiptRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: Parameters<ReceiptRepository["record"]>[0], tx?: SmsTransaction): Promise<{ receipt: DeliveryReceipt; created: boolean }> {
    const client = db(this.pool, tx);
    const redactedPayload = input.redactedPayload === undefined ? null : JSON.stringify(projectSafeReceiptPayload(input.redactedPayload));
    const inserted = input.messageId === undefined
      ? await client.query<Row>(`insert into sms_kit.delivery_receipt (id, tenant_id, message_id, match_status, dedupe_key, provider_biz_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source, redacted_payload) values ($1, null, null, 'unmatched', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) on conflict (dedupe_key) do nothing returning ${fields}`,
        [randomUUID(), input.dedupeKey, input.providerBizId, input.deliveryStatus, input.providerCode ?? null, input.providerMessage ?? null, input.occurredAt, input.receivedAt, input.source, redactedPayload])
      : await client.query<Row>(`insert into sms_kit.delivery_receipt (id, tenant_id, message_id, match_status, dedupe_key, provider_biz_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source, redacted_payload) select $1, m.tenant_id, m.id, 'matched', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb from sms_kit.send_message m where m.id = $11 and m.tenant_id = $12 on conflict (dedupe_key) do nothing returning ${fields}`,
        [randomUUID(), input.dedupeKey, input.providerBizId, input.deliveryStatus, input.providerCode ?? null, input.providerMessage ?? null, input.occurredAt, input.receivedAt, input.source, redactedPayload, input.messageId, input.tenantId]);
    if (inserted.rows[0] !== undefined) return { receipt: receipt(inserted.rows[0]), created: true };
    if (input.messageId === undefined) return { receipt: unmatchedReceipt(input), created: false };
    const existing = await client.query<Row>(`select ${fields} from sms_kit.delivery_receipt where dedupe_key = $1 and tenant_id = $2 and message_id = $3`, [input.dedupeKey, input.tenantId, input.messageId]);
    if (existing.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "receipt belongs to a different tenant");
    return { receipt: receipt(existing.rows[0]), created: false };
  }
}
