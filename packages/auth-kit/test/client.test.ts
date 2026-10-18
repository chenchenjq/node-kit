import { describe, expect, it } from "vitest";
import { AuthClientError, createAuthClient } from "../src/react/client.js";

describe("client baseline", () => {
  it("translates server error payloads into AuthClientError", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "手机号或密码错误，或当前无法登录",
          },
          serverTime: 1234567890,
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      );

    const client = createAuthClient({
      basePath: "/api/auth-kit",
      fetch: mockFetch,
    });

    try {
      await client.signInPassword({
        phoneNumber: "13800138000",
        password: "wrong",
        captchaId: "1234567890123456",
        captchaAnswer: "1234",
      });
      expect.unreachable("should have thrown");
    } catch (caught) {
      expect(caught).toBeInstanceOf(AuthClientError);
      const err = caught as AuthClientError;
      expect(err.code).toBe("INVALID_CREDENTIALS");
      expect(err.message).toBe("手机号或密码错误，或当前无法登录");
      expect(err.serverTime).toBe(1234567890);
    }
  });

  it("handles network failure as UNAVAILABLE", async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error("Network offline");
    };

    const client = createAuthClient({ fetch: mockFetch });

    try {
      await client.signOut();
      expect.unreachable("should have thrown");
    } catch (caught) {
      expect(caught).toBeInstanceOf(AuthClientError);
      const err = caught as AuthClientError;
      expect(err.code).toBe("UNAVAILABLE");
    }
  });
});

