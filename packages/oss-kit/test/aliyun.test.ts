import OSS from "ali-oss";
import { afterEach, expect, it, vi } from "vitest";
import { createAliyunTransport } from "../src/server/aliyun.js";
import { credentials } from "./helpers.js";
import type { StorageSummary } from "../src/types.js";
const config: StorageSummary = { id: "a", name: "a", region: "oss-cn-hangzhou", bucket: "test-bucket", endpoint: "https://oss-cn-hangzhou-internal.aliyuncs.com", access: "private", publicDomain: null, enabled: true, isDefault: true, used: false, revision: 1 };
afterEach(() => vi.restoreAllMocks());
it("uses the real SDK V4 signer against an external browser endpoint", async () => {
  const client = createAliyunTransport(config, credentials, { timeoutMs: 1000, browser: true });
  const url = new URL(await client.sign("app/files/a.txt", 300));
  expect(url.protocol).toBe("https:"); expect(url.hostname).toBe("test-bucket.oss-cn-hangzhou.aliyuncs.com");
  expect(url.searchParams.get("x-oss-signature-version")).toBe("OSS4-HMAC-SHA256");
  expect(url.searchParams.get("x-oss-expires")).toBe("300");
  expect(url.searchParams.has("x-oss-signature")).toBe(true);
});
it("signs a configured CNAME with the SDK rather than rewriting the signed URL", async () => {
  const client = createAliyunTransport({ ...config, publicDomain: "https://files.example.com" }, credentials, { timeoutMs: 1000, browser: true });
  const url = new URL(await client.sign("app/files/a.txt", 60));
  expect(url.hostname).toBe("files.example.com"); expect(url.searchParams.has("x-oss-signature")).toBe(true);
});
it("sends server-side forbidden-overwrite control and private object ACL", async () => {
  const requests: { key: string; options: OSS.PutObjectOptions | undefined }[] = [];
  vi.spyOn(OSS.prototype, "put").mockImplementation(async (key, _body, options) => { requests.push({ key, options }); return {} as OSS.PutObjectResult; });
  const client = createAliyunTransport(config, credentials, { timeoutMs: 1234, browser: false });
  await client.put("app/a.txt", Buffer.from("hello"), "text/plain", true);
  expect(requests[0]).toMatchObject({ key: "app/a.txt", options: { timeout: 1234, mime: "text/plain", headers: { "x-oss-forbid-overwrite": "true", "x-oss-object-acl": "private" } } });
});
