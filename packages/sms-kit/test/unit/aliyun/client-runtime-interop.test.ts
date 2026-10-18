import { describe, expect, it } from "vitest";

import { AliyunSdkClientFactory } from "../../../src/aliyun/client.js";

describe("Aliyun SDK runtime interop", () => {
  it("constructs the CommonJS SDK client under the TypeScript runtime loader", () => {
    expect(() =>
      new AliyunSdkClientFactory().create({
        region: "cn-hangzhou",
        accessKeyId: "test-access-key-id",
        accessKeySecret: "test-access-key-secret",
      }),
    ).not.toThrow();
  });
});
