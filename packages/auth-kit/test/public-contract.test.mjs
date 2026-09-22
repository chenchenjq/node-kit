import { describe, expect, it, vi } from "vitest";

import { createAuthSchema, authSchemaSql } from "auth-kit/schema";
import { AuthKitError, createAuthKit, hashPassword, validatePassword, verifyPassword } from "auth-kit/server";
import { AuthClientError, createAuthClient, AuthForms } from "auth-kit/react";

describe("public package contract", () => {
  it("keeps the documented server, schema and React entry points available", () => {
    expect(typeof createAuthSchema).toBe("function");
    expect(typeof hashPassword).toBe("function");
    expect(typeof createAuthClient).toBe("function");
    expect(typeof AuthForms).toBe("function");
    expect(new AuthKitError("UNAUTHENTICATED", 401).status).toBe(401);
  });

  it("provides SQL only for a dedicated authentication namespace", () => {
    expect(authSchemaSql("oms_auth")).toContain('CREATE SCHEMA "oms_auth"');
    expect(() => authSchemaSql("public")).toThrow();
    expect(() => createAuthSchema("Invalid-Name")).toThrow();
  });

  it("hashes new passwords and still verifies an existing hash", async () => {
    const password = "OriginalPassword123";
    const hash = await hashPassword(password);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword({ hash, password })).toBe(true);
    expect(await verifyPassword({ hash, password: "wrong-password" })).toBe(false);
    expect(() => validatePassword("letters-only")).toThrow();
  });

  it("preserves same-origin credentials and structured client errors", async () => {
    const request = vi.fn(async () => Response.json({
      error: { code: "RATE_LIMITED", message: "请稍后重试" },
      retryAt: 60000,
      serverTime: 1000,
    }, { status: 429 }));
    const client = createAuthClient({ basePath: "/api/auth-kit/", fetch: request });
    await expect(client.sendSms({ phoneNumber: "+8613800138000", purpose: "sms-login", captchaId: "id", captchaAnswer: "abcd" }))
      .rejects.toMatchObject({ code: "RATE_LIMITED", retryAt: 60000 });
    expect(request).toHaveBeenCalledWith("/api/auth-kit/sms/send", expect.objectContaining({
      method: "POST", credentials: "same-origin",
    }));
    expect(AuthClientError.name).toBe("AuthClientError");
  });

  it("keeps every documented client operation on its public HTTP path", async () => {
    const calls = [];
    const client = createAuthClient({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, credentials: init.credentials });
        return Response.json({ status: true });
      },
    });
    await client.captcha("sms-login");
    await client.sendSms({ phoneNumber: "+8613800138000", purpose: "sms-login", captchaId: "id", captchaAnswer: "abcd" });
    await client.signInPassword({ phoneNumber: "+8613800138000", password: "OriginalPassword123", captchaId: "id", captchaAnswer: "abcd" });
    await client.signInSms({ phoneNumber: "+8613800138000", code: "123456" });
    await client.resetPassword({ phoneNumber: "+8613800138000", code: "123456", newPassword: "Replacement123" });
    await client.changePassword({ currentPassword: "OriginalPassword123", newPassword: "Replacement123" });
    await client.signOut();
    await client.getSession();
    expect(calls.map(({ url, method }) => `${method} ${url}`)).toEqual([
      "POST /api/auth-kit/captcha",
      "POST /api/auth-kit/sms/send",
      "POST /api/auth-kit/sign-in/password",
      "POST /api/auth-kit/sign-in/sms",
      "POST /api/auth-kit/password/reset",
      "POST /api/auth-kit/password/change",
      "POST /api/auth-kit/sign-out",
      "GET /api/auth-kit/session",
    ]);
    expect(calls.every(({ credentials }) => credentials === "same-origin")).toBe(true);
  });

  it("rejects an unknown endpoint without touching host persistence", async () => {
    const kit = createAuthKit({
      appId: "baseline-test",
      baseURL: "http://127.0.0.1:3000",
      secret: "A".repeat(32),
      pool: {}, schema: {}, redis: {},
      sms: { tenantId: "trusted-host-id", sendService: { sendOtpNow: vi.fn() } },
      resolveClientIp: () => "127.0.0.1",
    });
    const response = await kit.handler(new Request("http://127.0.0.1:3000/api/auth-kit/unknown"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("validates every public POST request before using host persistence", async () => {
    const kit = createAuthKit({
      appId: "baseline-test",
      baseURL: "http://127.0.0.1:3000",
      secret: "A".repeat(32),
      pool: { connect: vi.fn(() => { throw new Error("unexpected database access"); }) },
      schema: {}, redis: {},
      sms: { tenantId: "trusted-host-id", sendService: { sendOtpNow: vi.fn() } },
      resolveClientIp: () => "127.0.0.1",
    });
    for (const path of ["captcha", "sms/send", "sign-in/password", "sign-in/sms", "password/reset", "password/change", "sign-out"]) {
      const response = await kit.handler(new Request(`http://127.0.0.1:3000/api/auth-kit/${path}`, {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
        body: path === "sign-out" ? "{" : "{}",
      }));
      expect(response.status, path).toBe(400);
    }
    const crossOrigin = await kit.handler(new Request("http://127.0.0.1:3000/api/auth-kit/sign-out", {
      method: "POST", headers: { origin: "https://untrusted.example", "content-type": "application/json" }, body: "{}",
    }));
    expect(crossOrigin.status).toBe(403);
  });
});
