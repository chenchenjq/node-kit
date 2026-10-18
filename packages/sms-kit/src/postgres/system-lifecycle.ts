import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PhoneNumberProtector, SmsProvider, ProviderReceipt } from "../ports/index.js";
import { parseAliyunReceiptBatch } from "../aliyun/receipt.js";
import type { MessageId } from "../core/types.js";

// The package's tenant job pipeline cannot process SYSTEM records. Keep this
// PostgreSQL adapter explicitly fenced to SYSTEM/null; no tenant sends or rows are touched.
export class PgSystemSmsLifecycle {
  constructor(private readonly deps: { pool: Pool; provider: SmsProvider; phoneProtector: PhoneNumberProtector;
    config: { get(): Promise<{ status: string; enabled: boolean; region?: string; endpoint?: string; accessKeyIdRef?: string; accessKeySecretRef?: string }> } }) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.deps.pool.connect();
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  }

  async recover(now = new Date()) {
    return this.transaction(async client => {
      const result = await client.query(`WITH candidates AS (
        SELECT id FROM sms_kit.send_message WHERE scope_type='SYSTEM' AND tenant_id IS NULL
        AND acceptance_status='pending' AND submitted_at<$1 ORDER BY submitted_at LIMIT 100 FOR UPDATE SKIP LOCKED)
        UPDATE sms_kit.send_message m SET acceptance_status='unknown',delivery_status='waiting',final_error_code='ACCEPTANCE_UNKNOWN',
        version=version+1,updated_at=$2 FROM candidates c WHERE m.id=c.id RETURNING m.id`, [new Date(now.getTime()-300_000), now]);
      for (const row of result.rows) await client.query(`UPDATE sms_kit.otp_challenge c SET delivery_acceptance_status='unknown',
        invalidated_at=coalesce(invalidated_at,$2),terminal_error_code='ACCEPTANCE_UNKNOWN'
        FROM sms_kit.send_message m WHERE m.id=$1 AND m.idempotency_key='system-auth:' || c.id
        AND c.scope_type='SYSTEM' AND c.tenant_id IS NULL AND c.delivery_acceptance_status='pending'`, [row.id, now]);
      return result.rowCount || 0;
    });
  }

  private async record(client: PoolClient, report: Omit<ProviderReceipt, "bizId"> & { bizId?: string }, source: "callback" | "query", now: Date) {
    // Callback ownership requires both opaque OutId and the persisted BizId.
    const found = report.outId ? await client.query(`SELECT id,provider_biz_id FROM sms_kit.send_message
      WHERE scope_type='SYSTEM' AND tenant_id IS NULL AND id::text=$1
      AND (provider_biz_id=$2 OR ($3='query' AND provider_biz_id IS NULL)) FOR UPDATE`, [report.outId, report.bizId, source]) : { rows: [] };
    const message = found.rows[0];
    const dedupe = createHash("sha256").update(JSON.stringify([source, report.outId, report.bizId, report.deliveryStatus, report.occurredAt.toISOString()])).digest("hex");
    // Persist unmatched callbacks too; no telephone number or provider text is retained.
    await client.query(`INSERT INTO sms_kit.delivery_receipt(id,scope_type,tenant_id,message_id,match_status,dedupe_key,
      provider_biz_id,provider_out_id,delivery_status,provider_code,occurred_at,received_at,source,redacted_payload)
      VALUES($1,'SYSTEM',NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{"redactedFields":["phone","provider-message"]}'::jsonb)
      ON CONFLICT(dedupe_key) DO UPDATE SET message_id=coalesce(delivery_receipt.message_id,EXCLUDED.message_id),
      match_status=CASE WHEN coalesce(delivery_receipt.message_id,EXCLUDED.message_id) IS NULL THEN 'unmatched' ELSE 'matched' END`,
      [randomUUID(),message?.id || null,message ? "matched" : "unmatched",dedupe,report.bizId,report.outId || null,report.deliveryStatus,report.providerCode || null,report.occurredAt,now,source]);
    if (message) await client.query(`UPDATE sms_kit.send_message SET delivery_status=$2,
      delivered_at=CASE WHEN $2='delivered' THEN $3 ELSE delivered_at END,finalized_at=$3,
      acceptance_status=CASE WHEN acceptance_status='unknown' THEN 'accepted' ELSE acceptance_status END,
      final_error_code=CASE WHEN $2='failed' THEN 'PROVIDER_REJECTED' ELSE NULL END,version=version+1,updated_at=$4
      WHERE id=$1 AND scope_type='SYSTEM' AND tenant_id IS NULL AND delivery_status='waiting'`, [message.id,report.deliveryStatus,report.occurredAt,now]);
    return Boolean(message);
  }

  async ingest(input: { body: string | Uint8Array; deadlineAt: Date; signal?: AbortSignal }) {
    const reports = parseAliyunReceiptBatch(input.body);
    const check = () => { if (input.signal?.aborted || Date.now()+30 >= input.deadlineAt.getTime()) throw new Error("RECEIPT_DEADLINE"); };
    await this.transaction(async client => {
      check(); await client.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1,input.deadlineAt.getTime()-Date.now()-30))]);
      for (const report of reports) { check(); await this.record(client, report, "callback", new Date()); }
      check();
    });
    return { acknowledgement: { code: 0, msg: "成功" } };
  }

  async reconcile(now = new Date()) {
    const config = await this.deps.config.get();
    if (config.status !== "ready" || !config.enabled || !config.region || !config.accessKeyIdRef || !config.accessKeySecretRef) return 0;
    const messages = (await this.deps.pool.query(`SELECT id,phone_ciphertext,phone_key_id,provider_biz_id,submitted_at FROM sms_kit.send_message
      WHERE scope_type='SYSTEM' AND tenant_id IS NULL AND acceptance_status IN ('accepted','unknown') AND delivery_status='waiting'
      AND submitted_at>$1 AND phone_ciphertext IS NOT NULL ORDER BY submitted_at LIMIT 50`, [new Date(now.getTime()-172_800_000)])).rows;
    let reconciled = 0;
    for (const message of messages) {
      const phone = await this.deps.phoneProtector.unprotect({ ciphertext: message.phone_ciphertext, keyId: message.phone_key_id },
        { envelopeVersion: 1, purpose: "phone", tenantId: null, recordId: message.id as MessageId, fieldName: "phone_ciphertext" });
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(message.submitted_at);
      const sendDate = ["year","month","day"].map(type => parts.find(p => p.type===type)!.value).join("");
      for (let page=1;page<=5;page++) {
        const result = await this.deps.provider.queryDelivery({ region: config.region, ...(config.endpoint ? { endpoint: config.endpoint } : {}),
          accessKeyId: config.accessKeyIdRef, accessKeySecret: config.accessKeySecretRef, phoneNumber: phone, sendDate, currentPage: page, pageSize: 50,
          ...(message.provider_biz_id ? { bizId: message.provider_biz_id } : {}) });
        if (result.kind !== "page") break;
        const item = result.items.find(i => i.outId===message.id && i.status!=="waiting");
        if (item && (item.status==="delivered" || item.status==="failed")) {
          await this.transaction(client => this.record(client, { outId: message.id, ...(message.provider_biz_id ? { bizId: message.provider_biz_id } : {}), deliveryStatus: item.status as "delivered" | "failed", occurredAt: item.occurredAt || now, ...(item.providerCode ? { providerCode: item.providerCode } : {}) }, "query", now));
          reconciled++; break;
        }
        if (!result.hasNextPage) break;
      }
    }
    await this.deps.pool.query(`UPDATE sms_kit.send_message SET delivery_status='unknown_final',final_error_code='DELIVERY_UNKNOWN',
      finalized_at=$1,updated_at=$1,version=version+1 WHERE scope_type='SYSTEM' AND tenant_id IS NULL AND delivery_status='waiting' AND submitted_at<$2`, [now,new Date(now.getTime()-172_800_000)]);
    return reconciled;
  }
}
