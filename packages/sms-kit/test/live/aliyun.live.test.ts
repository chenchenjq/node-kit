import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createAliyunProvider } from "../../src/aliyun/index.js";
import { isCloudApproved } from "../../src/core/resource-usability.js";
import { maskMainlandPhone, normalizeMainlandPhone } from "../../src/core/phone.js";
import { EnvSecretResolver } from "../../src/security/env-secret-resolver.js";
import { positiveTimeoutMs } from "../../src/ports/provider.js";
import { assertLiveTestGuard, claimSingleLiveSend, isTestResourceName } from "./live-test-guard.js";

async function runSingleLiveScenario(): Promise<void> {
  const configuration = assertLiveTestGuard(process.env);
  const provider = createAliyunProvider({ secretResolver: new EnvSecretResolver(process.env) });
  const auth = {
    region: "cn-hangzhou",
    accessKeyId: configuration.accessKeyIdRef,
    accessKeySecret: configuration.accessKeySecretRef,
  };

  // Read-only calls verify account access and resolve the exact approved test resources.
  await provider.testConnection(auth);
  const [signatures, templates] = await Promise.all([
    provider.listSignatures({ ...auth, pageSize: 100 }),
    provider.listTemplates({ ...auth, pageSize: 100 }),
  ]);
  const signature = signatures.items.find((item) => item.externalName === configuration.signatureName);
  const template = templates.items.find((item) => item.externalCode === configuration.templateCode);
  if (signature === undefined || !isTestResourceName(signature.externalName) || !isCloudApproved(signature.externalStatus)) {
    throw new Error("Configured Aliyun signature is absent, unapproved, or not marked as a test resource");
  }
  if (template === undefined || !isTestResourceName(template.externalName) || !isCloudApproved(template.externalStatus)) {
    throw new Error("Configured Aliyun template is absent, unapproved, or not marked as a test resource");
  }
  if (template.templateType !== "notification" ||
      template.variableNames.length !== Object.keys(configuration.templateParams).length ||
      !template.variableNames.every((name) => Object.hasOwn(configuration.templateParams, name))) {
    throw new Error("The selected test template must be a notification template with matching parameters");
  }

  claimSingleLiveSend();
  console.info(`Aliyun live test: recipient ${maskMainlandPhone(normalizeMainlandPhone(configuration.phone))}; template ${maskTemplateCode(configuration.templateCode)}`);
  const result = await provider.send({
    ...auth,
    phoneNumber: normalizeMainlandPhone(configuration.phone),
    signatureName: configuration.signatureName,
    templateCode: configuration.templateCode,
    templateParams: configuration.templateParams,
    outId: `sms-kit-live-${randomUUID()}`,
    timeoutMs: positiveTimeoutMs(10_000),
  });
  expect(result.kind, "Aliyun must acknowledge the single explicitly authorized test message").toBe("accepted");
}

function maskTemplateCode(code: string): string {
  if (code.length <= 5) return "***";
  return `${code.slice(0, 3)}***${code.slice(-2)}`;
}

describe.skipIf(process.env.SMS_KIT_LIVE_TEST !== "1")("Aliyun live", () => {
  it("lists test resources and sends one explicitly allowed test message", async () => {
    await runSingleLiveScenario();
  }, 60_000);
});
