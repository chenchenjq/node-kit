import { expect, it } from "vitest";
import { runLiveDeliveryScenario } from "../../live/live-scenario.js";
import { createAliyunProvider } from "../../../src/aliyun/index.js";
import { FakeAliyunApi, signFixture, templateFixture } from "../../../src/testing/fake-aliyun-api.js";

it("exercises the guarded live scenario through normal persisted dispatch, audit and statistics", async () => {
  const api = new FakeAliyunApi().withSignatures([{ ...signFixture(), signName: "SMS KIT 测试" }]).withTemplates([{ ...templateFixture(), templateCode: "SMS_TEST_001", templateName: "SMS KIT 测试模板", templateType: 0, outerTemplateType: 1, templateContent: "code ${code}" }]);
  const secretResolver = { resolve: async () => "test-fixture-only" };
  const environment = {
    SMS_KIT_LIVE_TEST: "1", SMS_KIT_LIVE_NON_PRODUCTION: "1", SMS_KIT_LIVE_ALLOW_SEND: "1",
    SMS_KIT_LIVE_ACCESS_KEY_ID_REF: "env://TEST_ID", SMS_KIT_LIVE_ACCESS_KEY_SECRET_REF: "env://TEST_SECRET",
    TEST_ID: "fixture-only", TEST_SECRET: "fixture-only", SMS_KIT_LIVE_PHONE: "13800138000", SMS_KIT_LIVE_PHONE_ALLOWLIST: "13800138000",
    SMS_KIT_LIVE_SIGN_NAME: "SMS KIT 测试", SMS_KIT_LIVE_TEMPLATE_CODE: "SMS_TEST_001", SMS_KIT_LIVE_TEMPLATE_PARAMS: '{"code":"000000"}',
  };
  const result = await runLiveDeliveryScenario({ environment, provider: createAliyunProvider({ api, secretResolver }), secretResolver });
  expect(result).toMatchObject({ acceptanceStatus: "accepted", attemptCount: 1, heldCount: 1, reconcileJobs: 1, acceptedCount: 1 });
  expect(result.auditActions).toEqual(expect.arrayContaining(["config.save", "config.test_connection", "resource.sync.commit", "sms.test"]));
  expect(api.calls.sendSms).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/13800138000|fixture-only|000000/);
}, 120_000);
