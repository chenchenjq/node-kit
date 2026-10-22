import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createOssKit, createAesGcmCredentialProtector, errorInfo } from "oss-kit/server";
import { validatePrefix } from "oss-kit/rules";
import { memoryStore } from "./mock-host.mjs";
const required = ["OSS_KIT_LIVE_BUCKET", "OSS_KIT_LIVE_REGION", "OSS_KIT_LIVE_PREFIX", "OSS_KIT_LIVE_ACCESS_KEY_ID", "OSS_KIT_LIVE_ACCESS_KEY_SECRET", "OSS_KIT_ENCRYPTION_KEY"];
if (process.env.OSS_KIT_LIVE_CONFIRM !== "test-bucket-only" || required.some(name => !process.env[name])) {
  console.log("未实测：未提供完整的显式测试 Bucket/前缀授权及服务端凭据；没有执行任何云请求。");
  process.exit(0);
}
const prefix = validatePrefix(process.env.OSS_KIT_LIVE_PREFIX);
const kit = createOssKit({ store: memoryStore(), applicationPrefix: prefix, testPrefixes: [prefix], authorize: async () => true, credentials: createAesGcmCredentialProtector(process.env.OSS_KIT_ENCRYPTION_KEY), timeoutMs: 30000 });
const credentials = { accessKeyId: process.env.OSS_KIT_LIVE_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_KIT_LIVE_ACCESS_KEY_SECRET, ...(process.env.OSS_KIT_LIVE_STS_TOKEN ? { stsToken: process.env.OSS_KIT_LIVE_STS_TOKEN } : {}) };
const input = { name: "Explicit test storage", bucket: process.env.OSS_KIT_LIVE_BUCKET, region: process.env.OSS_KIT_LIVE_REGION, access: "private" };
let reference, config;
const report = { connection: null, upload: "not-run", signedGet: "not-run", anonymousDenied: "not-run", delete: "not-run" };
try {
  report.connection = await kit.testStorage({}, { input, credentials, prefix: `${prefix}/connection` });
  assert.equal(report.connection.upload.status, "passed"); assert.equal(report.connection.read.status, "passed"); assert.equal(report.connection.delete.status, "passed");
  config = await kit.createStorage({}, input, credentials); await kit.setDefaultStorage({}, config.id);
  await kit.saveStrategy({}, { code: "live_test", name: "Explicit test only", description: "Not a host business strategy", prefix: "objects", allowedExtensions: ["txt"], allowedMimeTypes: ["text/plain"], maxSizeBytes: 1024 });
  const content = `oss-kit-live-test:${randomUUID()}`;
  reference = await kit.upload({}, { strategyCode: "live_test", originalName: "probe.txt", mimeType: "text/plain", body: Buffer.from(content) }); report.upload = "passed";
  const signed = await kit.getAccessLink({}, reference, { expiresInSeconds: 60 });
  const read = await fetch(signed.url, { signal: AbortSignal.timeout(30000), redirect: "error" });
  assert.equal(read.status, 200); assert.equal(await read.text(), content); report.signedGet = "passed";
  const anonymous = await fetch(`https://${config.bucket}.${config.region}.aliyuncs.com/${reference.objectKey}`, { signal: AbortSignal.timeout(30000), redirect: "error" });
  try { assert.equal(anonymous.status, 403, "Private object must deny anonymous access"); report.anonymousDenied = "passed"; } finally { await anonymous.body?.cancel(); }
} catch (error) { report.error = errorInfo(error); process.exitCode = 1; }
finally {
  if (reference) {
    try { await kit.delete({}, reference); report.delete = "passed"; }
    catch (error) { report.delete = "failed"; report.cleanupObjectKey = reference.objectKey; report.cleanupError = errorInfo(error); process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
}
