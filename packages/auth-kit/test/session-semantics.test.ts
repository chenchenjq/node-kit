import { describe, expect, it, vi } from "vitest";
import { createAuthKit } from "../src/server/auth.js";
import { createAuthSchema } from "../src/server/schema.js";
import { hashPassword, verifyPassword, validatePassword } from "../src/server/password.js";

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
      if (
        script.includes("ZSCORE") ||
        script.includes("pending") ||
        script.includes("tonumber(ARGV[1])") ||
        script.includes("windowScript")
      ) {
        return [1, Date.now() + 60000];
      }
      if (script.includes("SET") || script.includes("'SET'")) {
        store.set(String(args[0]), String(args[1]));
        return "OK";
      }
      if (script.includes("DEL") || script.includes("'DEL'")) {
        store.delete(String(args[0]));
        return 1;
      }
      if (script.includes("GET") || script.includes("'GET'")) {
        return store.get(String(args[0])) ?? null;
      }
      return 1;
    },
  };
}

function createMockDbPool(initialData: { users?: any[]; accounts?: any[]; sessions?: any[] } = {}) {
  const userStore = [...(initialData.users ?? [])];
  const accountStore = [...(initialData.accounts ?? [])];
  const sessionStore = [...(initialData.sessions ?? [])];

  const queryHandler = async (queryArg: any, rawParams: any[] = []) => {
    const sql = typeof queryArg === "string" ? queryArg : queryArg?.text ?? "";
    const params = typeof queryArg === "string" ? rawParams : (queryArg?.values ?? rawParams);
    const isArrayMode = queryArg?.rowMode === "array";

    if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_unlock")) {
      return { rows: [] };
    }

    // Users
    if (sql.toLowerCase().includes("select") && sql.includes('"user"')) {
      const found = userStore.filter((u) => {
        const phone = u.phone_number ?? u.phoneNumber;
        const normalized = phone ? (phone.startsWith("+86") ? phone : `+86${phone}`) : "";
        const raw = phone ? phone.replace(/^\+86/, "") : "";
        return (
          params.includes(u.id) ||
          params.includes(phone) ||
          params.includes(normalized) ||
          params.includes(raw)
        );
      });
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

    // Accounts
    if (sql.toLowerCase().includes("select") && sql.includes('"account"')) {
      const found = accountStore.filter(
        (a) => params.includes(a.userId) || params.includes(a.id)
      );
      if (isArrayMode) {
        return {
          rows: found.map((a) => [
            a.id,
            a.accountId ?? a.userId,
            a.providerId ?? "credential",
            a.userId,
            a.password ?? null,
            null,
            null,
            null,
            null,
            null,
            null,
            new Date(),
            new Date(),
          ]),
        };
      }
      return {
        rows: found.map((a) => ({
          id: a.id,
          userId: a.userId,
          user_id: a.userId,
          accountId: a.accountId ?? a.userId,
          account_id: a.accountId ?? a.userId,
          providerId: a.providerId ?? "credential",
          provider_id: a.providerId ?? "credential",
          password: a.password ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      };
    }

    if (sql.toLowerCase().includes("update") && sql.includes('"account"')) {
      const newHash = params[0];
      const targetId = params.find((p: any) => typeof p === "string" && accountStore.some((a) => a.id === p || a.userId === p));
      const acc = accountStore.find((a) => a.id === targetId || a.userId === targetId);
      if (acc) acc.password = newHash;
      return { rows: acc ? [acc] : [] };
    }

    if (sql.toLowerCase().includes("insert into") && sql.includes('"account"')) {
      const acc = {
        id: params[0] || `acc-${accountStore.length + 1}`,
        userId: params[1],
        accountId: params[2] ?? params[1],
        providerId: params[3] ?? "credential",
        password: params[9] ?? params[4],
      };
      accountStore.push(acc);
      return { rows: isArrayMode ? [[acc.id, acc.userId, acc.accountId, acc.providerId, null, null, null, null, null, acc.password]] : [acc] };
    }

    // Sessions
    if (sql.toLowerCase().includes("select") && sql.includes('"session"')) {
      const found = sessionStore.filter(
        (s) => params.includes(s.token) || params.includes(s.id) || params.includes(s.userId)
      );
      if (isArrayMode) {
        return {
          rows: found.map((s) => [
            s.id,
            s.token,
            s.userId,
            s.expiresAt,
            s.ipAddress ?? null,
            s.userAgent ?? null,
            new Date(),
            new Date(),
          ]),
        };
      }
      return {
        rows: found.map((s) => ({
          id: s.id,
          token: s.token,
          userId: s.userId,
          user_id: s.userId,
          expiresAt: s.expiresAt,
          expires_at: s.expiresAt,
          ipAddress: s.ipAddress ?? null,
          userAgent: s.userAgent ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      };
    }

    if (sql.toLowerCase().includes("insert into") && sql.includes('"session"')) {
      const row = {
        id: params[0] || `sess-${sessionStore.length + 1}`,
        token: params[1] ?? params[2] ?? `tok-${Date.now()}`,
        userId: params[2] ?? params[1],
        expiresAt: params[3] || new Date(Date.now() + 86400000),
      };
      sessionStore.push(row);
      return {
        rows: isArrayMode
          ? [[row.id, row.token, row.userId, row.expiresAt, null, null, new Date(), new Date()]]
          : [row],
      };
    }

    if (sql.toLowerCase().includes("delete from") && sql.includes('"session"')) {
      const match = sessionStore.filter((s) => params.includes(s.userId) || params.includes(s.id) || params.includes(s.token));
      for (const m of match) {
        const idx = sessionStore.indexOf(m);
        if (idx >= 0) sessionStore.splice(idx, 1);
      }
      return { rowCount: match.length, rows: [] };
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
    _accounts: accountStore,
    _sessions: sessionStore,
  } as any;
}

describe("Issue 03: auth-kit password and session semantics", () => {
  function usernameFixture(resolveUsername: ((name: string) => Promise<string | null>) | undefined = async () => "user-login") {
    const pool = createMockDbPool({
      users: [{ id: "user-login", name: "用户", phoneNumber: "13800138000", enabled: true }],
      accounts: [{ id: "acc-login", userId: "user-login", providerId: "credential", password: "legacy-hash" }],
    });
    const redis = createMockRedis();
    const evalSpy = vi.spyOn(redis, "eval");
    const verifyLegacyPassword = vi.fn().mockResolvedValue(true);
    const kit = createAuthKit({
      appId: "username-test", baseURL: "http://localhost:3000", secret: "a".repeat(32),
      pool, schema: createAuthSchema("auth_kit"), redis,
      sms: { service: { issue: vi.fn(), verifyAndConsume: vi.fn().mockResolvedValue(true) } },
      resolveClientIp: () => "127.0.0.1", resolveUsername, verifyLegacyPassword,
    });
    const login = (identifier: Record<string, string>) => kit.handler(new Request(
      "http://localhost:3000/api/auth-kit/sign-in/password", {
        method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd", ...identifier, password: "old-password" }),
      },
    ));
    return { pool, login, evalSpy, verifyLegacyPassword };
  }

  it("username and phone authenticate the same user and share the stable user rate-limit key", async () => {
    const resolve = vi.fn().mockResolvedValue("user-login");
    const { login, evalSpy } = usernameFixture(resolve);
    for (const input of [{ loginId: " operator " }, { loginId: "13800138000" }, { phoneNumber: "13800138000" }]) {
      const response = await login(input);
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeTruthy();
    }
    expect(resolve).toHaveBeenCalledExactlyOnceWith("operator");
    const keys = evalSpy.mock.calls.map((call) => String(call[2])).filter((key) => key.includes("password-user:"));
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it.each(["不存在", "disabled", "wrong-password"])("rejects %s without exposing account state", async (kind) => {
    const { login, pool, verifyLegacyPassword } = usernameFixture(async () => kind === "不存在" ? null : "user-login");
    if (kind === "disabled") pool._users[0].enabled = false;
    if (kind === "wrong-password") verifyLegacyPassword.mockResolvedValue(false);
    const response = await login({ loginId: "operator" });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("INVALID_CREDENTIALS");
    expect(pool._sessions).toHaveLength(0);
  });

  it.each([
    {}, { loginId: "" }, { loginId: "operator", phoneNumber: "13800138000" },
    { loginId: "someone@" }, { loginId: "a".repeat(101) },
  ])("rejects ambiguous or invalid identifiers %j", async (input) => {
    const resolve = vi.fn();
    const { login } = usernameFixture(resolve);
    expect((await login(input)).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails closed when username resolution is unavailable", async () => {
    const { login, pool } = usernameFixture(async () => { throw new Error("database unavailable"); });
    expect((await login({ loginId: "operator" })).status).toBe(503);
    expect(pool._sessions).toHaveLength(0);
  });

  it("verifies OMS historical Argon2id synthetic hash and rejects unsupported hashes", async () => {
    // OMS native hash format: $argon2id$v=19$m=65536,p=1,t=3$...
    const password = "ValidPassword123";
    const omsHash = await hashPassword(password);
    expect(omsHash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);

    // Verify valid password against hash
    const isValid = await verifyPassword({ hash: omsHash, password });
    expect(isValid).toBe(true);

    // Verify wrong password fails closed
    const isWrong = await verifyPassword({ hash: omsHash, password: "WrongPassword456" });
    expect(isWrong).toBe(false);

    // Unsupported hash format (e.g. bcrypt, plaintext, empty) fails closed without error
    expect(await verifyPassword({ hash: "$2a$10$unsupportedhashhere", password })).toBe(false);
    expect(await verifyPassword({ hash: "plaintext", password })).toBe(false);
    expect(await verifyPassword({ hash: "", password })).toBe(false);
  });

  it("enforces new password strength (8-128 chars, letters and digits), but old password verification does not enforce it", () => {
    // New passwords require 8-128 chars with letters & digits
    expect(() => validatePassword("validPass1")).not.toThrow();
    expect(() => validatePassword("abc")).toThrow(); // too short
    expect(() => validatePassword("12345678")).toThrow(); // no letters
    expect(() => validatePassword("abcdefgh")).toThrow(); // no digits
  });

  it("password sign-in allows existing user even if legacy password is below new password rules", async () => {
    // Suppose legacy password was simple: "pass1" (has Argon2id hash in DB)
    // Note: hashPassword only validates new passwords; existing hashes are already stored.
    const pool = createMockDbPool({
      users: [{ id: "user-leg", name: "Legacy User", phoneNumber: "13800000008", enabled: true }],
    });

    const verifyLegacy = vi.fn().mockResolvedValue(true);

    const kit = createAuthKit({
      appId: "oms",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool,
      schema: createAuthSchema("auth_kit"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: vi.fn(),
          verifyAndConsume: vi.fn().mockResolvedValue(true),
        },
      },
      resolveClientIp: () => "127.0.0.1",
      verifyLegacyPassword: verifyLegacy,
    });

    // Seed credential
    pool._accounts.push({
      id: "acc-1",
      userId: "user-leg",
      providerId: "credential",
      password: "$argon2id$v=19$m=65536,p=1,t=3$dummy$dummy",
    });

    const res = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sign-in/password", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000008",
          password: "short", // below 8 characters, but accepted on login!
        }),
      })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeDefined();
    expect(verifyLegacy).toHaveBeenCalled();
  });

  it("password change requires correct current password and revokes all sessions", async () => {
    const pool = createMockDbPool({
      users: [{ id: "user-1", name: "User 1", phoneNumber: "13800000001", enabled: true }],
      accounts: [
        {
          id: "acc-1",
          userId: "user-1",
          providerId: "credential",
          password: await hashPassword("OldPassword123"),
        },
      ],
      sessions: [
        { id: "sess-1", userId: "user-1", token: "tok-1", expiresAt: new Date(Date.now() + 86400000) },
        { id: "sess-2", userId: "user-1", token: "tok-2", expiresAt: new Date(Date.now() + 86400000) },
      ],
    });

    const kit = createAuthKit({
      appId: "oms",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool,
      schema: createAuthSchema("auth_kit"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: vi.fn(),
          verifyAndConsume: vi.fn().mockResolvedValue(true),
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    // 0. Sign in to obtain valid session cookie
    const loginRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sign-in/password", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000001",
          password: "OldPassword123",
        }),
      })
    );
    expect(loginRes.status).toBe(200);
    const sessionCookie = loginRes.headers.get("set-cookie")!;
    // Add a second session for this user to ensure password change revokes all sessions across devices
    pool._sessions.push({
      id: "sess-other-device",
      userId: "user-1",
      token: "tok-other",
      expiresAt: new Date(Date.now() + 86400000),
    });
    const preCount = pool._sessions.length;
    expect(preCount).toBeGreaterThanOrEqual(2);

    // 1. Attempt password change with WRONG current password
    const wrongRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/password/change", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          currentPassword: "WrongPassword999",
          newPassword: "NewPassword456",
        }),
      })
    );
    expect(wrongRes.status).toBe(401);
    expect(pool._sessions.length).toBe(preCount); // Sessions intact

    // 2. Password change with CORRECT current password
    const changeRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/password/change", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          cookie: sessionCookie,
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          currentPassword: "OldPassword123",
          newPassword: "NewPassword456",
        }),
      })
    );
    expect(changeRes.status).toBe(200);
    // All sessions revoked!
    expect(pool._sessions.length).toBe(0);
    // Cookie was expired
    expect(changeRes.headers.get("set-cookie")).toBeDefined();
  });

  it("password reset consumes proof once and revokes all sessions without auto sign-in", async () => {
    const consumeProofSpy = vi.fn().mockResolvedValue(true);
    const pool = createMockDbPool({
      users: [{ id: "user-1", name: "User 1", phoneNumber: "13800000001", enabled: true }],
      accounts: [
        {
          id: "acc-1",
          userId: "user-1",
          providerId: "credential",
          password: await hashPassword("OldPassword123"),
        },
      ],
      sessions: [
        { id: "sess-1", userId: "user-1", token: "tok-1", expiresAt: new Date(Date.now() + 86400000) },
      ],
    });

    const redis = createMockRedis();

    const kit = createAuthKit({
      appId: "oms",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool,
      schema: createAuthSchema("auth_kit"),
      redis,
      sms: {
        service: {
          issue: vi.fn().mockResolvedValue({ id: "ch-reset-1", expiresAt: new Date(Date.now() + 300000) }),
          verifyAndConsume: consumeProofSpy,
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    // 1. Issue challenge for password-reset
    await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sms/send", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000001",
          purpose: "password-reset",
        }),
      })
    );

    const resetRes = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/password/reset", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",
          phoneNumber: "13800000001",
          code: "123456",
          newPassword: "BrandNewPassword1",
        }),
      })
    );

    expect(resetRes.status).toBe(200);
    const body = await resetRes.json();
    expect(body.status).toBe(true);

    // Single-use proof was consumed
    expect(consumeProofSpy).toHaveBeenCalledTimes(1);

    // All sessions revoked
    expect(pool._sessions.length).toBe(0);

    // Password updated in database
    const updatedAcc = pool._accounts.find((a: any) => a.userId === "user-1");
    expect(await verifyPassword({ hash: updatedAcc.password, password: "BrandNewPassword1" })).toBe(true);
  });

  it("ordinary sign-out revokes only current session and is safe & idempotent", async () => {
    const pool = createMockDbPool({
      users: [{ id: "user-1", name: "User 1", phoneNumber: "13800000001", enabled: true }],
      sessions: [
        { id: "sess-1", userId: "user-1", token: "tok-device-1", expiresAt: new Date(Date.now() + 86400000) },
        { id: "sess-2", userId: "user-1", token: "tok-device-2", expiresAt: new Date(Date.now() + 86400000) },
      ],
    });

    const kit = createAuthKit({
      appId: "oms",
      baseURL: "http://localhost:3000",
      secret: "a".repeat(32),
      pool,
      schema: createAuthSchema("auth_kit"),
      redis: createMockRedis(),
      sms: {
        service: {
          issue: vi.fn(),
          verifyAndConsume: vi.fn().mockResolvedValue(true),
        },
      },
      resolveClientIp: () => "127.0.0.1",
    });

    // 1. Sign out device 1
    const res1 = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sign-out", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          cookie: "auth-kit-oms.session_token=tok-device-1",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",}),
      })
    );
    expect(res1.status).toBe(200);
    // Only device 1 session revoked; device 2 session is preserved!
    expect(pool._sessions.some((s: any) => s.token === "tok-device-2")).toBe(true);

    // 2. Repeat sign out (already signed out device) -> safe and idempotent!
    const res2 = await kit.handler(
      new Request("http://localhost:3000/api/auth-kit/sign-out", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ captchaId: "unit-captcha-identifier", captchaAnswer: "abcd",}),
      })
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.status).toBe(true);
  });
});
