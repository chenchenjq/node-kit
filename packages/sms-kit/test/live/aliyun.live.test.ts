import { describe, expect, it } from "vitest";
import { createAliyunProvider } from "../../src/aliyun/index.js";
import { maskMainlandPhone } from "../../src/core/phone.js";
import { EnvSecretResolver } from "../../src/security/env-secret-resolver.js";
import { assertLiveTestGuard } from "./live-test-guard.js";
import { runLiveDeliveryScenario } from "./live-scenario.js";

describe.skipIf(process.env.SMS_KIT_LIVE_TEST !== "1")("Aliyun live", () => {
  it("runs one authorized test message through persisted dispatch, audit and statistics", async () => {
    const configuration = assertLiveTestGuard(process.env);
    const secretResolver = new EnvSecretResolver(process.env);
    console.info(`Aliyun live test: recipient ${maskMainlandPhone(configuration.phone as never)}; template ${configuration.templateCode.slice(0, 3)}***${configuration.templateCode.slice(-2)}`);
    const result = await runLiveDeliveryScenario({ environment: process.env, provider: createAliyunProvider({ secretResolver }), secretResolver });
    expect(result).toMatchObject({ acceptanceStatus: "accepted", attemptCount: 1, heldCount: 1, reconcileJobs: 1, acceptedCount: 1 });
    expect(result.auditActions).toContain("sms.test");
  }, 120_000);
});
