import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type { MessageId } from "../../core/types.js";
import type { DeliveryReceipt, ReceiptRepository, SmsTransaction } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Row = { id: string; message_id: string | null; match_status: DeliveryReceipt["matchStatus"]; dedupe_key: string; provider_biz_id: string; delivery_status: DeliveryReceipt["deliveryStatus"]; provider_code: string | null; provider_message: string | null; occurred_at: Date; received_at: Date; source: DeliveryReceipt["source"] };
function db(pool: Pool, tx?: SmsTransaction): Pool | PoolClient { return tx === undefined ? pool : (tx as PgSmsTransaction).client; }
function receipt(row: Row, tenantId: DeliveryReceipt["tenantId"]): DeliveryReceipt { return { id: row.id, tenantId, ...(row.message_id === null ? {} : { messageId: row.message_id as MessageId }), matchStatus: row.match_status, dedupeKey: row.dedupe_key, providerBizId: row.provider_biz_id, deliveryStatus: row.delivery_status, ...(row.provider_code === null ? {} : { providerCode: row.provider_code }), ...(row.provider_message === null ? {} : { providerMessage: row.provider_message }), occurredAt: row.occurred_at, receivedAt: row.received_at, source: row.source }; }
const fields = "id, message_id, match_status, dedupe_key, provider_biz_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source";

export class PgReceiptRepository implements ReceiptRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: Parameters<ReceiptRepository["record"]>[0], tx?: SmsTransaction): Promise<{ receipt: DeliveryReceipt; created: boolean }> {
    const matchStatus = input.messageId === undefined ? "unmatched" : "matched";
    const inserted = await db(this.pool, tx).query<Row>(`insert into sms_kit.delivery_receipt (id, message_id, match_status, dedupe_key, provider_biz_id, delivery_status, provider_code, provider_message, occurred_at, received_at, source, redacted_payload) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) on conflict (dedupe_key) do nothing returning ${fields}`,
      [randomUUID(), input.messageId ?? null, matchStatus, input.dedupeKey, input.providerBizId, input.deliveryStatus, input.providerCode ?? null, input.providerMessage ?? null, input.occurredAt, input.receivedAt, input.source, input.redactedPayload === undefined ? null : JSON.stringify(input.redactedPayload)]);
    if (inserted.rows[0] !== undefined) return { receipt: receipt(inserted.rows[0], input.tenantId), created: true };
    const existing = await db(this.pool, tx).query<Row>(`select ${fields} from sms_kit.delivery_receipt r left join sms_kit.send_message m on m.id = r.message_id where r.dedupe_key = $1 and (r.message_id is null or m.tenant_id = $2)`, [input.dedupeKey, input.tenantId]);
    if (existing.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "receipt belongs to a different tenant");
    return { receipt: receipt(existing.rows[0], input.tenantId), created: false };
  }
}
