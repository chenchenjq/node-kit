import { z } from "zod";

import { SmsKitError } from "../core/errors.js";

export const ALIYUN_RECEIPT_MAX_BODY_BYTES = 64 * 1024;
export const ALIYUN_RECEIPT_MAX_BATCH_ITEMS = 100;

const receiptSchema = z.array(z.object({
  phone_number: z.string().min(1).max(32),
  biz_id: z.string().min(1).max(128),
  send_time: z.string().max(64),
  report_time: z.string().max(64),
  success: z.boolean(),
  err_code: z.string().max(128),
  err_msg: z.string().max(512),
  sms_size: z.string().regex(/^\d+$/).max(16),
  out_id: z.string().max(128),
}).strict()).max(ALIYUN_RECEIPT_MAX_BATCH_ITEMS);

export type AliyunReceipt = Readonly<{
  bizId: string;
  outId: string;
  occurredAt: Date;
  deliveryStatus: "delivered" | "failed";
  providerCode: string;
  providerMessage: string;
}>;

function invalidReceipt(): never {
  throw new SmsKitError("CONFIG_INVALID", "invalid Aliyun delivery receipt");
}

function parseAliyunTimestamp(value: string): Date {
  // Mainland SmsReport timestamps are China Standard Time, without an offset.
  const fields = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (fields === null) return invalidReceipt();
  const [year, month, day, hour, minute, second] = fields.slice(1).map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) return invalidReceipt();
  const occurredAt = new Date(`${value.replace(" ", "T")}+08:00`);
  if (Number.isNaN(occurredAt.getTime())) return invalidReceipt();
  return occurredAt;
}

/**
 * Bounds and projects an untrusted Aliyun SmsReport HTTP JSON batch. The
 * callback telephone is deliberately used only for schema validation and is
 * never returned or made available to persistence callers.
 */
export function parseAliyunReceiptBatch(body: string | Uint8Array): readonly AliyunReceipt[] {
  if (typeof body === "string" && Buffer.byteLength(body, "utf8") > ALIYUN_RECEIPT_MAX_BODY_BYTES) return invalidReceipt();
  if (typeof body !== "string" && body.byteLength > ALIYUN_RECEIPT_MAX_BODY_BYTES) return invalidReceipt();
  const raw = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidReceipt();
  }
  const reports = receiptSchema.safeParse(value);
  if (!reports.success) return invalidReceipt();
  return reports.data.map((report) => {
    // Validate both provider timestamps even though only report_time becomes
    // the receipt occurrence time.
    parseAliyunTimestamp(report.send_time);
    return Object.freeze({
    bizId: report.biz_id,
    outId: report.out_id,
    occurredAt: parseAliyunTimestamp(report.report_time),
    deliveryStatus: report.success ? "delivered" : "failed",
    providerCode: report.err_code,
    providerMessage: report.err_msg,
    });
  });
}
