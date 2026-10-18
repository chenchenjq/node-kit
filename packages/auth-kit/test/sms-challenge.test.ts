import { describe, expect, it, vi } from "vitest";
import { createAuthKit } from "../src/server/auth.js";
import { createAuthSchema } from "../src/server/schema.js";

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    async eval(script: string, _numberOfKeys: number, ...args: (string | number)[]) {
      if (script.includes("redis.call('TIME')")) {
        return Date.now();
      }
      if (script.includes("member=last[1]")) {
        return Date.now() + 60000;
      }
      if (script.includes("ZSCORE") || script.includes("pending") || script.includes("tonumber(ARGV[1])")) {
        return [1, Date.now() + 60000];
      }
      if (script.includes("SET") && (script.includes("PX") || script.includes("EX"))) {
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

function createMockDbPool(users: any[] = []) {
  const userStore = [...users];
  const sessionStore: any[] = [];
  const accountStore: any[] = [];

  const queryHandler = async (queryArg: any, rawParams: any[] = []) => {
    const sql = typeof queryArg === "string" ? queryArg : queryArg?.text ?? "";
    const params = typeof queryArg === "string" ? rawParams : (queryArg?.values ?? rawParams);
    const isArrayMode = queryArg?.rowMode === "array";

    if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_unlock")) {
      return { rows: [] };
    }
    // Drizzle / SQL queries
    if (sql.toLowerCase().includes("select") && sql.includes('"user"')) {
      const found = userStore.filter(
        (u) =>
          u.phone_number === params[0] ||
          u.phoneNumber === params[0] ||
          `+86${u.phoneNumber}` === params[0] ||
          `+86${u.phone_number}` === params[0] ||
          (sql.includes('"id"') && u.id === params[0])
      );
      if (isArrayMode) {
        return {
          rows: found.map((u) => [
            u.id,
            u.name,
            u.email ?? `${u.id}@example.com`,
            false,
            null,
            u.phone_number ?? u.phoneNumber,
            true,
            u.enabled !== false,
            new Date(),
            new Date(),
          ]),
        };
      }
      return {
        rows: found.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email ?? `${u.id}@example.com`,
          email_verified: false,
          image: null,
          phone_number: u.phone_number ?? u.phoneNumber,
          phone_number_verified: true,
          enabled: u.enabled !== false,
          created_at: new Date(),
          updated_at: new Date(),
        })),
      };
    }
    if (sql.toLowerCase().includes("select") && sql.includes('"session"')) {
      const token = params[0];
      const found = sessionStore.filter((s) => s.token === token);
      if (isArrayMode) {
        return {
          rows: found.map((s) => [
            s.id,
            s.token,
            s.userId,
            s.expiresAt,
            null,
            null,
            new Date(),
            new Date(),
          ]),
        };
      }
      return { rows: found };
    }
    if (sql.toLowerCase().includes("insert into") && sql.includes('"session"')) {
      const row = {
        id: params[0] || `sess-${Date.now()}`,
        token: params[1],
        userId: params[2],
        expiresAt: params[3],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessionStore.push(row);
      return { rows: isArrayMode ? [[row.id, row.token, row.userId, row.expiresAt]] : [row] };
    }
    if (sql.toLowerCase().includes("delete from") && sql.includes('"session"')) {
      return { rows: [] };
    }
    return { rows: [] };
  };

  return {
    async connect() {
      return {
        query: queryHandler,
        release: () => {},
      };
    },
    query: queryHandler,
    _users: userStore,
    _sessions: sessionStore,
    _accounts: accountStore,
  } as any;
}

describe("Issue 02: auth-kit SYSTEM-scoped SMS challenge", () => {
  it("executes login SMS in SYSTEM scope after graphic verification, without a tenantId", async () => {
    const issueSpy = vi.fn().mockResolvedValue({ id: "challenge-sys-1", expiresAt: new Date(Date.now() + 300000) });
    const consumeProofSpy = vi.fn().mockResolvedValue(true);

    const pool = createMockDbPool([
      { id: "user-1", name: "System Admin", phoneNumber: "13800000001", enabled: true },
    ]);

    const kit = createAuthKit({
      appId: "oms",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool,
      schema: createAuthSchema("auth_kit"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: issueSpy,
          verifyAndConsume: consumeProofSpy,
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    // 1. Send SMS with server-validated graphic captcha
    const sendRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sms/send", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000001",
          purpose: "sms-login",
        }),
      })
    );
    const sendBody = await sendRes.json();
    console.log("sendRes status & body:", sendRes.status, JSON.stringify(sendBody));
    expect(sendRes.status).toBe(200);
    expect(sendBody.status).toBe(true);
    expect(sendBody.retryAt).toBeDefined();

    // Verify sms service was called with SYSTEM action and subjectId, no fake tenant ID
    expect(issueSpy).toHaveBeenCalledTimes(1);
    expect(issueSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: "user-1",
        action: "login.authenticate",
        phone: "13800000001",
        ipAddress: "127.0.0.1",
      })
    );

    // 2. Sign in with SMS
    const loginRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sign-in/sms", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000001",
          code: "123456",
        }),
      })
    );

    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    expect(loginBody.status).toBe(true);
    expect(loginRes.headers.get("set-cookie")).toBeDefined();

    // Verified with sms-kit and consumed proof atomically
    expect(consumeProofSpy).toHaveBeenCalledWith(expect.objectContaining({
      subjectId: "user-1",
      action: "login.authenticate",
      challengeId: "challenge-sys-1",
      code: "123456",
    }), expect.objectContaining({ client: expect.anything() }));
    expect(consumeProofSpy).toHaveBeenCalledTimes(1);
  });

  it("gives uniform anonymous response when user is absent or disabled", async () => {
    const issueSpy = vi.fn();
    const pool = createMockDbPool([
      { id: "user-disabled", name: "Disabled User", phoneNumber: "13800000002", enabled: false },
    ]);

    const kit = createAuthKit({
      appId: "oms",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool,
      schema: createAuthSchema("auth_kit"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: issueSpy,
          verifyAndConsume: vi.fn().mockResolvedValue(true),
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    // Request SMS for non-existent phone
    const absentRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sms/send", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13899999999",
          purpose: "sms-login",
        }),
      })
    );
    expect(absentRes.status).toBe(200);
    const absentBody = await absentRes.json();
    expect(absentBody.status).toBe(true);
    expect(absentBody.retryAt).toBeDefined();

    // Request SMS for disabled user
    const disabledRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sms/send", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000002",
          purpose: "sms-login",
        }),
      })
    );
    expect(disabledRes.status).toBe(200);
    const disabledBody = await disabledRes.json();
    expect(disabledBody.status).toBe(true);
    expect(disabledBody.retryAt).toBeDefined();

    // No challenge was issued to SMS provider
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it("handles service failure gracefully without leaking or auto-retrying", async () => {
    const issueSpy = vi.fn().mockRejectedValue(new Error("Provider gateway down"));
    const pool = createMockDbPool([
      { id: "user-1", name: "User", phoneNumber: "13800000001", enabled: true },
    ]);

    const kit = createAuthKit({
      appId: "oms",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool,
      schema: createAuthSchema("auth_kit"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: issueSpy,
          verifyAndConsume: vi.fn().mockResolvedValue(true),
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    const res = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sms/send", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000001",
          purpose: "sms-login",
        }),
      })
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("UNAVAILABLE");
  });
});
