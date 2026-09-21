import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

// Vitest flattens this CommonJS package's default export, while the emitted
// Node ESM wrapper observes the package object. Preserve the runtime shape but
// keep the actual generated client and request implementations.
vi.mock("@alicloud/dysmsapi20170525", async () => {
  const sdk = createRequire(import.meta.url)("@alicloud/dysmsapi20170525") as Readonly<Record<string, unknown>>;
  return { ...sdk, default: sdk };
});

import { AliyunSdkClientFactory } from "../../../src/aliyun/client.js";
import { updateProviderConfigSchema } from "../../../src/next/types/config.js";

type HttpxModule = Readonly<{
  request: (url: string, options?: unknown) => Promise<unknown>;
}>;

const require = createRequire(import.meta.url);
const httpx = require("httpx") as HttpxModule;

afterEach(() => {
  vi.restoreAllMocks();
});

async function transportOrigin(endpoint: string): Promise<string> {
  const transport = vi.spyOn(httpx, "request").mockRejectedValue(new Error("transport intercepted"));
  const api = new AliyunSdkClientFactory().create({
    region: "cn-hangzhou",
    endpoint,
    accessKeyId: "test-access-key-id",
    accessKeySecret: "test-access-key-secret",
  });

  await expect(api.querySmsSignList({ pageIndex: 1, pageSize: 1 })).rejects.toBeDefined();

  const target = transport.mock.calls[0]?.[0];
  expect(typeof target).toBe("string");
  return new URL(target as string).origin;
}

describe("Aliyun SDK endpoint transport", () => {
  it("targets the HTTPS origin accepted by the public provider DTO", async () => {
    const input = updateProviderConfigSchema.parse({
      version: 0,
      idempotencyKey: "config:endpoint-transport",
      region: "cn-hangzhou",
      endpoint: "https://dysmsapi.aliyuncs.com",
      accessKeyIdRef: "env://ALIYUN_ACCESS_KEY_ID",
      accessKeySecretRef: "env://ALIYUN_ACCESS_KEY_SECRET",
    });

    await expect(transportOrigin(input.endpoint!)).resolves.toBe("https://dysmsapi.aliyuncs.com");
  });

  it.each([
    ["mixed-case HTTPS scheme", "HTTPS://sms.example.test", "https://sms.example.test"],
    ["URL host and port", "https://sms.example.test:8443", "https://sms.example.test:8443"],
    ["URL bracketed IPv6 and port", "https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
    ["URL explicit default HTTPS port", "https://sms.example.test:443", "https://sms.example.test"],
    ["legacy bare host and port", "sms.example.test:8443", "https://sms.example.test:8443"],
    ["legacy bare bracketed IPv6 and port", "[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
  ])("preserves %s at the real SDK transport boundary", async (_label, endpoint, expectedOrigin) => {
    await expect(transportOrigin(endpoint)).resolves.toBe(expectedOrigin);
  });

  it.each([
    ["an insecure URL", "http://sms.example.test"],
    ["a URL path", "https://sms.example.test/proxy"],
    ["URL credentials", "https://access-key:secret@sms.example.test"],
    ["empty URL userinfo", "https://@sms.example.test"],
    ["empty URL username and password", "https://:@sms.example.test"],
    ["a normalized dot path", "https://sms.example.test/a/.."],
    ["a percent-encoded dot path", "https://sms.example.test/%2e"],
    ["a URL query", "https://sms.example.test?access_key=secret"],
    ["a URL fragment", "https://sms.example.test#secret"],
    ["a bare-authority path", "sms.example.test/proxy"],
  ])("rejects %s before constructing the SDK client", (_label, endpoint) => {
    expect(() => new AliyunSdkClientFactory().create({
      region: "cn-hangzhou",
      endpoint,
      accessKeyId: "test-access-key-id",
      accessKeySecret: "test-access-key-secret",
    })).toThrow("invalid Aliyun endpoint");
  });
});
