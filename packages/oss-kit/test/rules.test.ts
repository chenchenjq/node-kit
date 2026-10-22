import { describe, it, expect } from "vitest";
import { previewObjectKey, validatePrefix } from "../src/rules/index.js";
import { validateStorage, validateStrategy } from "../src/server/validation.js";
import { storageInput, strategyInput } from "./helpers.js";
describe("validated paths and shared preview", () => {
  it.each(["../x", "a/../b", "/a", "a//b", "a\\b", "a/%2e%2e", "a\u0000", "a/.", "a/", "a?b", "a".repeat(201)])("rejects invalid prefix %j", path => expect(() => validatePrefix(path)).toThrow());
  it("uses host timezone at a UTC date boundary", () => {
    expect(previewObjectKey({ applicationPrefix: "app", strategy: { ...strategyInput, dateDirectory: "year-month-day", naming: "uuid" }, originalName: "photo.TXT", now: new Date("2026-09-30T16:01:00Z"), randomId: "random-123" })).toBe("app/attachments/2026/10/01/random-123.txt");
  });
  it("cleans filename and retains validated extension", () => {
    expect(previewObjectKey({ applicationPrefix: "app", strategy: { ...strategyInput, dateDirectory: "fixed", naming: "original-random" }, originalName: "a file!!.txt", randomId: "rnd" })).toBe("app/attachments/a-file-rnd.txt");
  });
  it("timestamp naming contains a random suffix", () => {
    expect(previewObjectKey({ applicationPrefix: "app", strategy: { ...strategyInput, dateDirectory: "year-month", naming: "timestamp-random" }, originalName: "x.txt", now: new Date("2026-09-01T00:00:00Z"), randomId: "rnd" })).toBe("app/attachments/2026/09/1788220800000-rnd.txt");
  });
  it.each(["a/b.txt", "a\\b.txt", "x.html", ".txt", "a\r.txt"])("rejects untrusted original name %s", originalName => expect(() => previewObjectKey({ applicationPrefix: "app", strategy: { ...strategyInput, dateDirectory: "fixed", naming: "uuid" }, originalName })).toThrow());
  it("rejects unsupported timezone", () => expect(() => previewObjectKey({ applicationPrefix: "app", strategy: { ...strategyInput, dateDirectory: "fixed", naming: "uuid" }, originalName: "a.txt", timeZone: "nonsense" })).toThrow());
});
describe("configuration validation", () => {
  it.each(["http://oss-cn-hangzhou.aliyuncs.com", "https://evil.com", "https://oss-cn-beijing.aliyuncs.com", "https://user@oss-cn-hangzhou.aliyuncs.com", "https://oss-cn-hangzhou.aliyuncs.com:8443", "https://oss-cn-hangzhou.aliyuncs.com/x"])("rejects unsafe endpoint %s", endpoint => expect(() => validateStorage({ ...storageInput, endpoint })).toThrow());
  it("allows matching internal endpoint but keeps private default", () => expect(validateStorage({ ...storageInput, endpoint: "https://oss-cn-hangzhou-internal.aliyuncs.com" })).toMatchObject({ access: "private", enabled: true }));
  it.each(["https://127.0.0.1", "https://localhost", "https://a.test/a", "http://files.example.com", "https://a.example.com?secret=x"])("rejects unsafe domain %s", publicDomain => expect(() => validateStorage({ ...storageInput, publicDomain, access: "public" })).toThrow());
  it("rejects active content and impossible size policies", () => {
    expect(() => validateStrategy({ ...strategyInput, allowedExtensions: ["svg"], allowedMimeTypes: ["image/svg+xml"] }, 32 * 1024 * 1024)).toThrow();
    expect(() => validateStrategy({ ...strategyInput, maxSizeBytes: 64 * 1024 * 1024 }, 32 * 1024 * 1024)).toThrow();
    expect(() => validateStrategy({ ...strategyInput, code: "中文名称" }, 32 * 1024 * 1024)).toThrow();
  });
});
