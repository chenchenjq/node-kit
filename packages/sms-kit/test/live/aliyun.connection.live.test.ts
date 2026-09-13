import { describe, expect, it } from "vitest";

import { createAliyunProvider } from "../../src/aliyun/index.js";
import { EnvSecretResolver } from "../../src/security/env-secret-resolver.js";
import { assertReadOnlyLiveGuard } from "./live-test-guard.js";

describe.skipIf(process.env.SMS_KIT_LIVE_CONNECTION_TEST !== "1")("Aliyun read-only live connection", () => {
  it("lists signatures and templates without sending", async () => {
    const credentials = assertReadOnlyLiveGuard(process.env);
    const provider = createAliyunProvider({ secretResolver: new EnvSecretResolver(process.env) });
    const result = await provider.testConnection({
      region: "cn-hangzhou",
      accessKeyId: credentials.accessKeyIdRef,
      accessKeySecret: credentials.accessKeySecretRef,
    });

    expect(result.status).toBe("ready");
  }, 60_000);
});
