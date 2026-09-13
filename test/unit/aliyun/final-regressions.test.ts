import { describe, expect, it, vi } from "vitest";
import { createAliyunProvider } from "../../../src/aliyun/index.js";
import { positiveTimeoutMs } from "../../../src/ports/provider.js";
import { FakeAliyunApi, signFixture } from "../../../src/testing/fake-aliyun-api.js";
import { validateVerificationPolicy } from "../../../src/application/policy-service.js";

const auth = { region: "cn-hangzhou", accessKeyId: "id-ref", accessKeySecret: "secret-ref" };
const send = { ...auth, phoneNumber: "+8613800138000" as never, signatureName: "Test", templateCode: "SMS_TEST", templateParams: {}, outId: "opaque-id", timeoutMs: positiveTimeoutMs(10) };
const resolver = { resolve: async () => "test-only" };

describe("final Aliyun boundary regressions", () => {
  it.each(["isv.BUSINESS_LIMIT_CONTROL", "isv.MOBILE_NUMBER_ILLEGAL"])("preserves explicit SDK rejection %s", async (code) => {
    const api = new FakeAliyunApi();
    api.sendSms = async () => { throw Object.assign(new Error("unsafe request context"), { code }); };
    await expect(createAliyunProvider({ api, secretResolver: resolver }).send(send)).resolves.toEqual({ kind: "rejected", code, retryable: code === "isv.BUSINESS_LIMIT_CONTROL" });
  });

  it("bounds an injected API call and ignores its eventual late response", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeAliyunApi();
      let resolve!: (value: any) => void;
      api.sendSms = () => new Promise((done) => { resolve = done; });
      const pending = createAliyunProvider({ api, secretResolver: resolver }).send(send);
      let outcome: unknown;
      void pending.then((result) => { outcome = result; });
      await vi.advanceTimersByTimeAsync(11);
      expect(outcome).toEqual({ kind: "unknown", code: "ACCEPTANCE_UNKNOWN" });
      resolve({ code: "OK", bizId: "late", requestId: "late" });
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ kind: "unknown", code: "ACCEPTANCE_UNKNOWN" });
    } finally { vi.useRealTimers(); }
  });

  it("does not begin an SDK request after credential resolution exceeded the deadline", async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeAliyunApi();
      let resolve!: (value: string) => void;
      const secret = new Promise<string>((done) => { resolve = done; });
      const pending = createAliyunProvider({ api, secretResolver: { resolve: () => secret } }).send(send);
      await vi.advanceTimersByTimeAsync(11);
      expect(await pending).toMatchObject({ kind: "unknown" });
      resolve("test-only");
      await vi.advanceTimersByTimeAsync(1);
      expect(api.calls.sendSms).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { code: "OK", totalCount: 2, smsSignList: [] },
    { code: "OK", totalCount: 1 },
    { code: "OK", totalCount: 1, currentPage: 2, smsSignList: [signFixture()] },
    { totalCount: 0, smsSignList: [] },
  ])("rejects incomplete pages on the production provider path: %j", async (page) => {
    const api = new FakeAliyunApi(); api.querySmsSignList = async () => page;
    await expect(createAliyunProvider({ api, secretResolver: resolver }).listSignatures({ ...auth, pageSize: 50 })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("requires an explicit successful permission response", async () => {
    const api = new FakeAliyunApi(); api.querySmsSignList = async () => ({});
    await expect(createAliyunProvider({ api, secretResolver: resolver }).testConnection(auth)).rejects.toBeDefined();
  });

  it("parses actual public receipts and never exposes phone or provider free text", () => {
    const result = createAliyunProvider({ secretResolver: resolver }).parseReceipt(JSON.stringify([{ phone_number: "13800138000", biz_id: "biz", out_id: "opaque-id", send_time: "2026-09-13 12:00:00", report_time: "2026-09-13 12:00:01", success: true, err_code: "DELIVERED", err_msg: "unsafe request context", sms_size: "1" }]));
    expect(result.items).toEqual([expect.objectContaining({ bizId: "biz", outId: "opaque-id", deliveryStatus: "delivered", occurredAt: new Date("2026-09-13T04:00:01Z") })]);
    expect(JSON.stringify(result)).not.toMatch(/13800138000|unsafe request context/);
    expect(result.acknowledgement).toEqual({ code: 0, msg: "成功" });
  });
});

const policy = { expectedVersion: 1, otpLength: 6, otpTtlSeconds: 300, otpMaxAttempts: 3, proofTtlSeconds: 300, phoneMinIntervalSeconds: 60, phoneHourlyLimit: 5, phoneDailyLimit: 10, ipWindowSeconds: 600, ipWindowLimit: 20, systemDailyBudget: null, circuitOpen: false };
describe("policy SQL boundaries", () => {
  it.each([{ phoneMinIntervalSeconds: 0 }, { phoneMinIntervalSeconds: 3601 }, { ipWindowSeconds: 59 }, { circuitOpen: "false" }])("rejects invalid policy %j", (patch) => {
    expect(() => validateVerificationPolicy({ ...policy, ...patch } as never)).toThrow();
  });
  it("accepts all positive PostgreSQL integer capacity limits", () => {
    expect(() => validateVerificationPolicy({ ...policy, phoneHourlyLimit: 2147483647, phoneDailyLimit: 2147483647, ipWindowLimit: 2147483647, systemDailyBudget: 2147483647 })).not.toThrow();
  });
});
