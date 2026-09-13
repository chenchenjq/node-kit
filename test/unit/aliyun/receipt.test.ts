import { describe, expect, it, vi } from "vitest";

import { parseAliyunReceiptBatch } from "../../../src/aliyun/receipt.js";

const report = {
  phone_number: "13800138000",
  biz_id: "biz-100",
  send_time: "2026-09-14 08:00:00",
  report_time: "2026-09-14 08:00:05",
  success: true,
  err_code: "DELIVERED",
  err_msg: "ok",
  sms_size: "1",
  out_id: "out-100",
};

describe("parseAliyunReceiptBatch", () => {
  it("accepts the documented strict SmsReport batch without retaining its phone number", () => {
    const parsed = parseAliyunReceiptBatch(JSON.stringify([report]));

    expect(parsed).toEqual([{
      bizId: "biz-100",
      outId: "out-100",
      occurredAt: new Date("2026-09-14T00:00:05.000Z"),
      deliveryStatus: "delivered",
      providerCode: "DELIVERED",
      providerMessage: "ok",
    }]);
    expect(JSON.stringify(parsed)).not.toContain("13800138000");
  });

  it("rejects an oversized body before it attempts JSON parsing", () => {
    expect(() => parseAliyunReceiptBatch("[".padEnd(65_537, " "))).toThrow(/invalid Aliyun delivery receipt/);
  });

  it("rejects callback fields beyond Alibaba's strict SmsReport shape", () => {
    expect(() => parseAliyunReceiptBatch(JSON.stringify([{ ...report, tenantId: "attacker" }]))).toThrow(/invalid Aliyun delivery receipt/);
  });

  it("checks Uint8Array byte length before allocating a decoding buffer", () => {
    const from = vi.spyOn(Buffer, "from");

    expect(() => parseAliyunReceiptBatch(new Uint8Array(65_537))).toThrow(/invalid Aliyun delivery receipt/);
    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
  });

  it("rejects an impossible send_time calendar date rather than normalizing it", () => {
    expect(() => parseAliyunReceiptBatch(JSON.stringify([{
      ...report,
      send_time: "2026-02-30 08:00:00",
    }]))).toThrow(/invalid Aliyun delivery receipt/);
  });
});
