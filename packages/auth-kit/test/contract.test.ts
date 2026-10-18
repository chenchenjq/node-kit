import { describe, expect, it } from "vitest";
import { createAuthKit } from "../src/server/auth.js";
import { createAuthSchema } from "../src/server/schema.js";

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    async eval(script: string, _numberOfKeys: number, ...args: (string | number)[]) {
      if (script.includes("redis.call('TIME')")) {
        return Date.now();
      }
      if (script.includes("windowScript") || script.includes("pending")) {
        return [1, Date.now() + 60000];
      }
      if (script.includes("SET") && script.includes("PX")) {
        store.set(String(args[0]), String(args[1]));
        return "OK";
      }
      if (script.includes("DEL")) {
        store.delete(String(args[0]));
        return 1;
      }
      if (script.includes("GET")) {
        return store.get(String(args[0])) ?? null;
      }
      return 1;
    },
  };
}

function createMockPool() {
  return {
    async connect() {
      return {
        query: async () => ({ rows: [] }),
        release: () => {},
      };
    },
  } as any;
}

describe("auth-kit public request handler baseline", () => {
  it("validates options strictly on construction", () => {
    const valid = {
      appId: "test-app",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool: createMockPool(),
      schema: createAuthSchema("test_auth"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: async () => ({ id: "ch-1", expiresAt: new Date() }),
          verifyAndConsume: async () => true,
        },
      },
      resolveClientIp: () => "127.0.0.1",
    };

    expect(() => createAuthKit(valid)).not.toThrow();

    expect(() =>
      createAuthKit({ ...valid, secret: "short" })
    ).toThrow("at least 32 characters");

    expect(() =>
      createAuthKit({ ...valid, appId: "invalid/app" })
    ).toThrow("appId");

    expect(() =>
      createAuthKit({ ...valid, basePath: "/api/invalid/" })
    ).toThrow("Invalid basePath");
  });

  it("handles unknown path with 404 NOT_FOUND", async () => {
    const kit = createAuthKit({
      appId: "test-app",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool: createMockPool(),
      schema: createAuthSchema("test_auth"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: async () => ({ id: "ch-1", expiresAt: new Date() }),
          verifyAndConsume: async () => true,
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    const res = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/unknown", {
        method: "GET",
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("enforces origin on POST requests with 403 FORBIDDEN", async () => {
    const kit = createAuthKit({
      appId: "test-app",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool: createMockPool(),
      schema: createAuthSchema("test_auth"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: async () => ({ id: "ch-1", expiresAt: new Date() }),
          verifyAndConsume: async () => true,
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    const res = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/captcha", {
        method: "POST",
        headers: {
          origin: "http://attacker.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd", purpose: "password-login" }),
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("generates captcha with valid purpose and returns challenge cookie", async () => {
    const kit = createAuthKit({
      appId: "test-app",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool: createMockPool(),
      schema: createAuthSchema("test_auth"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: async () => ({ id: "ch-1", expiresAt: new Date() }),
          verifyAndConsume: async () => true,
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    const res = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/captcha", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd", purpose: "password-login" }),
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("auth-kit-test-app.challenge=");
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.image).toContain("<svg");
    expect(body.expiresAt).toBeGreaterThan(body.serverTime);
  });
});
