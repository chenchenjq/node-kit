import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";
import { createOssKit, createAesGcmCredentialProtector } from "../src/server/index.js";
import { memoryStore, mockOss, credentials, storageInput, strategyInput } from "./helpers.js";
function setup() {
  const store = memoryStore(), oss = mockOss();
  const kit = createOssKit<boolean>({ store, applicationPrefix: "app", testPrefixes: ["authorized-test", "test"], credentials: createAesGcmCredentialProtector(Buffer.alloc(32, 7).toString("base64")), authorize: async ctx => ctx, ossTransportFactory: oss.factory });
  return { store, oss, kit };
}
async function ready() { const x = setup(); const config = await x.kit.createStorage(true, storageInput, credentials); await x.kit.setDefaultStorage(true, config.id); await x.kit.saveStrategy(true, strategyInput); return { ...x, config }; }
const upload = { strategyCode: "attachments", originalName: "file.txt", mimeType: "text/plain", body: Buffer.from("hello") };
describe("scope-safe storage and strategy lifecycle", () => {
  it("fails closed without security", async () => {
    const kit = createOssKit({ store: memoryStore(), applicationPrefix: "app", authorize: async () => true });
    await expect(kit.createStorage({}, storageInput, credentials)).rejects.toMatchObject({ code: "CREDENTIAL_SECURITY_REQUIRED" });
  });
  it("does not disclose encrypted or plaintext credentials in summaries", async () => {
    const { kit, store } = await ready();
    expect(JSON.stringify(await kit.listStorage(true))).not.toContain("credential");
    const records = await store.read(v => v.listStorage());
    expect(JSON.stringify(records)).not.toContain("test-secret");
  });
  it("concurrent default changes produce one enabled default", async () => {
    const { kit } = await ready();
    const b = await kit.createStorage(true, { ...storageInput, bucket: "other-bucket" }, credentials);
    const a = (await kit.listStorage(true))[0]!;
    await Promise.all(Array.from({ length: 40 }, (_, i) => kit.setDefaultStorage(true, i % 2 ? a.id : b.id)));
    expect((await kit.listStorage(true)).filter(c => c.enabled && c.isDefault)).toHaveLength(1);
  });
  it("keeps id/bucket/region immutable and rotates credentials without stale cache", async () => {
    const { kit, config, oss } = await ready();
    await expect(kit.updateStorage(true, config.id, { ...storageInput, bucket: "changed" })).rejects.toMatchObject({ code: "IMMUTABLE_LOCATION" });
    await kit.upload(true, upload);
    await kit.updateStorage(true, config.id, storageInput, { ...credentials, accessKeySecret: "rotated" });
    await kit.upload(true, upload);
    expect(oss.seenCredentials.at(-1)?.accessKeySecret).toBe("rotated");
    await kit.updateStorage(true, config.id, storageInput, { accessKeyId: "", accessKeySecret: "" });
    await kit.upload(true, upload);
    expect(oss.seenCredentials.at(-1)?.accessKeySecret).toBe("rotated");
  });
  it("denies admin and unapproved strategies/file ownership", async () => {
    const { kit } = await ready();
    await expect(kit.listStorage(false)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(kit.testStorage(false, { input: storageInput, credentials, prefix: "test" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(kit.upload(false, upload)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await kit.listStrategies(false)).toEqual([]);
    const ref = await kit.upload(true, upload);
    await expect(kit.getAccessLink(false, ref)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(kit.read(false, ref)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(kit.delete(false, ref)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("missing default, missing strategy and disabled policy are explicit", async () => {
    const { kit } = setup();
    await kit.saveStrategy(true, strategyInput);
    await expect(kit.upload(true, upload)).rejects.toMatchObject({ code: "NO_DEFAULT_STORAGE" });
    await expect(kit.upload(true, { ...upload, strategyCode: "invented" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await kit.saveStrategy(true, { ...strategyInput, enabled: false });
    await expect(kit.upload(true, upload)).rejects.toMatchObject({ code: "STRATEGY_DISABLED" });
  });
  it("explicit binding overrides default and disabled storage never falls back", async () => {
    const { kit, config } = await ready();
    const other = await kit.createStorage(true, { ...storageInput, bucket: "other-bucket" }, credentials);
    await kit.setDefaultStorage(true, other.id);
    await kit.saveStrategy(true, { ...strategyInput, storageConfigId: config.id });
    expect((await kit.upload(true, upload)).storageConfigId).toBe(config.id);
    await kit.setStorageEnabled(true, config.id, false);
    await expect(kit.upload(true, upload)).rejects.toMatchObject({ code: "STORAGE_DISABLED" });
    await expect(kit.setDefaultStorage(true, config.id)).rejects.toMatchObject({ code: "STORAGE_DISABLED" });
  });
  it("used storage cannot change historical object access semantics", async () => {
    const { kit, config } = await ready(); await kit.upload(true, upload);
    await expect(kit.updateStorage(true, config.id, { ...storageInput, access: "public" })).rejects.toMatchObject({ code: "IMMUTABLE_ACCESS" });
  });
  it("explicitly clears old STS tokens when rotating to long-term credentials", async () => {
    const { kit, oss } = setup();
    const config = await kit.createStorage(true, storageInput, { ...credentials, stsToken: "old-token" });
    await kit.setDefaultStorage(true, config.id); await kit.saveStrategy(true, strategyInput);
    await kit.updateStorage(true, config.id, storageInput, { ...credentials, accessKeySecret: "new-key", clearStsToken: true });
    await kit.upload(true, upload);
    expect(oss.seenCredentials.at(-1)).toEqual({ accessKeyId: "test-id", accessKeySecret: "new-key" });
  });
});
describe("actual byte and content validation", () => {
  it("limits bytes regardless of caller MIME or advertised length", async () => {
    const { kit } = await ready();
    await kit.saveStrategy(true, { ...strategyInput, maxSizeBytes: 4 });
    await expect(kit.upload(true, upload)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(kit.upload(true, { ...upload, body: Readable.from([Buffer.from("abc"), Buffer.from("def")]) })).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
  it.each([Buffer.from("<html><script>alert(1)</script>"), Buffer.from("<svg xmlns='x'>"), Buffer.from([0xff, 0, 0xfe])])("does not trust text MIME", async body => {
    const { kit, oss } = await ready();
    await expect(kit.upload(true, { ...upload, body })).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
    expect(oss.objects.size).toBe(0);
  });
  it("does not trust extension or content type", async () => {
    const { kit } = await ready();
    await expect(kit.upload(true, { ...upload, originalName: "x.jpg" })).rejects.toMatchObject({ code: "INVALID_FILE" });
    await expect(kit.upload(true, { ...upload, mimeType: "image/jpeg" })).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
  });
  it("random keys avoid same-name overwrite", async () => {
    const { kit, oss } = await ready(); const a = await kit.upload(true, upload), b = await kit.upload(true, upload);
    expect(a.objectKey).not.toBe(b.objectKey); expect(a.size).toBe(5); expect(oss.objects.size).toBe(2);
  });
  it("recognizes image signatures and rejects disguised text", async () => {
    const { kit } = await ready();
    await kit.saveStrategy(true, { ...strategyInput, allowedExtensions: ["png"], allowedMimeTypes: ["image/png"] });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgT8AAAAASUVORK5CYII=", "base64");
    expect((await kit.upload(true, { ...upload, body: png, originalName: "x.png", mimeType: "image/png" })).mimeType).toBe("image/png");
    await expect(kit.upload(true, { ...upload, originalName: "x.png", mimeType: "image/png" })).rejects.toMatchObject({ code: "TYPE_MISMATCH" });
  });
  it("times out a stalled input stream without retaining it", async () => {
    const store = memoryStore(), oss = mockOss();
    const kit = createOssKit({ store, applicationPrefix: "app", timeoutMs: 10, authorize: async () => true, credentials: createAesGcmCredentialProtector(Buffer.alloc(32, 1).toString("base64")), ossTransportFactory: oss.factory });
    await kit.saveStrategy({}, strategyInput);
    const body = new Readable({ read() {} });
    await expect(kit.upload({}, { ...upload, body })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(body.destroyed).toBe(true);
  });
  it("returns on timeout even when a Readable source ignores cancellation", async () => {
    const kit = createOssKit({ store: memoryStore(), applicationPrefix: "app", timeoutMs: 10, authorize: async () => true });
    await kit.saveStrategy({}, strategyInput);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    async function* source() { await pending; yield Buffer.from("hello"); }
    const body = Readable.from(source());
    try {
      const result = await Promise.race([kit.upload({}, { ...upload, body }).then(() => "unexpected", e => e.code), new Promise<string>(resolve => setTimeout(() => resolve("hung"), 200))]);
      expect(result).toBe("TIMEOUT");
    } finally { release(); }
  });
});
describe("historical file references", () => {
  it("default and strategy changes never relocate existing files", async () => {
    const { kit, config } = await ready(); const ref = await kit.upload(true, upload);
    const b = await kit.createStorage(true, { ...storageInput, bucket: "new-bucket" }, credentials);
    await kit.setDefaultStorage(true, b.id);
    await kit.saveStrategy(true, { ...strategyInput, prefix: "new-prefix", enabled: false });
    const stream = await kit.read(true, ref); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("hello");
    const link = await kit.getAccessLink(true, ref);
    expect(link.expiresAt).not.toBeNull(); expect(link.url).toContain(ref.objectKey);
    await kit.setStorageEnabled(true, config.id, false);
    await expect(kit.read(true, ref)).rejects.toMatchObject({ code: "STORAGE_DISABLED" });
    await kit.setStorageEnabled(true, config.id, true); await kit.delete(true, ref);
    await expect(kit.read(true, ref)).rejects.toMatchObject({ code: "OSS_ERROR" });
  });
  it("rejects references outside the app prefix and unsigned active content", async () => {
    const { kit } = await ready(); const ref = await kit.upload(true, upload);
    await expect(kit.getAccessLink(true, { ...ref, objectKey: "other-app/a.txt" })).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(kit.getAccessLink(true, ref, { expiresInSeconds: 86400 })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
  it("public access only follows explicit administrator configuration", async () => {
    const { kit, config } = await ready();
    await kit.updateStorage(true, config.id, { ...storageInput, access: "public", publicDomain: "https://files.example.com" });
    const ref = await kit.upload(true, upload);
    expect(await kit.getAccessLink(true, ref)).toEqual({ url: `https://files.example.com/${ref.objectKey}`, expiresAt: null, access: "public" });
    // This checks link construction; it does not establish cloud anonymous access.
  });
});
describe("connection test step failures and safe errors", () => {
  it("tests drafts without listing buckets or persisting them", async () => {
    const { kit, oss } = setup(); const result = await kit.testStorage(true, { input: storageInput, credentials, prefix: "authorized-test" });
    expect(result.upload.status).toBe("passed"); expect(result.read.status).toBe("passed"); expect(result.delete.status).toBe("passed");
    expect(oss.objects.size).toBe(0); expect(await kit.listStorage(true)).toEqual([]);
  });
  it("reports cleanup failure, preserves only this object and does not expose SDK error messages", async () => {
    const { kit, oss } = setup(); oss.failures.get = Object.assign(new Error("secret https://signed?signature=bad"), { code: "AccessDenied", requestId: "request-123" });
    oss.failures.delete = new Error("cleanup failed");
    const result = await kit.testStorage(true, { input: storageInput, credentials, prefix: "authorized-test" });
    expect(result.read.status).toBe("failed"); expect(result.delete.status).toBe("failed"); expect(result.cleanupRequired).toBe(true);
    expect(JSON.stringify(result)).not.toContain("https://signed"); expect(result.read.error?.requestId).toBe("request-123");
    expect([...oss.objects.keys()]).toEqual([`draft/${result.objectKey}`]);
  });
  it("attempts cleanup even when upload fails ambiguously", async () => {
    const { kit, oss } = setup(); oss.failures.put = new Error("network");
    const result = await kit.testStorage(true, { input: storageInput, credentials, prefix: "authorized-test" });
    expect(result.upload.status).toBe("failed"); expect(result.read.status).toBe("skipped"); expect(result.delete.status).toBe("passed");
  });
  it("rejects test prefixes outside the server allowlist", async () => {
    const { kit } = setup();
    await expect(kit.testStorage(true, { input: storageInput, credentials, prefix: "production" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("disabled configs cannot bypass inactivity through connection tests", async () => {
    const { kit, config } = await ready(); await kit.setStorageEnabled(true, config.id, false);
    await expect(kit.testStorage(true, { input: storageInput, storageConfigId: config.id, prefix: "authorized-test" })).rejects.toMatchObject({ code: "STORAGE_DISABLED" });
    await expect(kit.testStorage(true, { input: { ...storageInput, enabled: false }, credentials, prefix: "authorized-test" })).rejects.toMatchObject({ code: "STORAGE_DISABLED" });
  });
});
