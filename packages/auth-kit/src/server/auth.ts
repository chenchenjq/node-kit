import { randomUUID, createHash } from "node:crypto";
import svgCaptcha from "svg-captcha";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { asSmsTransaction } from "sms-kit/postgres";
import type { AuthSession } from "../types.js";
import type { AuthKitOptions } from "./options.js";
import { AuthKitError, errorResponse } from "./errors.js";
import { SecurityState } from "./state.js";
import { validatePassword, hashPassword, verifyPassword } from "./password.js";
import { createFramework } from "./framework.js";
import {
  assertOrigin,
  bodies,
  challengeCookie,
  parseBody,
  type BodyPath,
} from "./request.js";

export type AuthKit = {
  handler(request: Request): Promise<Response>;
  getSession(request: Request): Promise<AuthSession | null>;
};

function lockKey(app: string, phone: string): string {
  return createHash("sha256")
    .update(`${app}:${phone}`)
    .digest()
    .readBigInt64BE()
    .toString();
}

function identifier(phone: string, purpose: string): string {
  return purpose === "sms-login" ? phone : `${phone}-request-password-reset`;
}

function validateOptions(options: AuthKitOptions): void {
  if (
    !/^[a-zA-Z0-9_-]{1,48}$/.test(options.appId) ||
    typeof options.secret !== "string" ||
    options.secret.length < 32
  )
    throw new Error(
      "appId and an auth secret of at least 32 characters are required"
    );
  for (const origin of options.developmentOrigins ?? []) {
    const candidate = new URL(origin), host = candidate.hostname;
    const privateIPv4 = /^(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host);
    if (process.env.NODE_ENV === "production" || candidate.origin !== origin || candidate.protocol !== "http:" ||
        !(privateIPv4 || ["localhost", "127.0.0.1", "[::1]"].includes(host))) throw new Error("Development origins must be explicit private-network HTTP origins outside production");
  }
  const url = new URL(options.baseURL);
  if (
    url.origin !== options.baseURL ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "baseURL must be an exact HTTPS public origin (HTTP loopback is allowed for development)"
    );
  if (
    !/^\/[a-zA-Z0-9/_-]+$/.test(options.basePath ?? "/api/auth-kit") ||
    (options.basePath ?? "").endsWith("/")
  )
    throw new Error("Invalid basePath");
  if (
    !options.sms?.service ||
    typeof options.sms.service.issue !== "function" ||
    typeof options.sms.service.verifyAndConsume !== "function" ||
    typeof options.resolveClientIp !== "function" ||
    (options.resolveUsername !== undefined && typeof options.resolveUsername !== "function") ||
    options.wechat?.enabled
  )
    throw new Error("Invalid host configuration");
}

export function createAuthKit(options: AuthKitOptions): AuthKit {
  validateOptions(options);
  const basePath = options.basePath ?? "/api/auth-kit";
  const state = new SecurityState(options.redis, options.appId, options.secret);
  const dummyHash = hashPassword("AuthKitDummyPassword1!");

  async function enforce(
    scope: string,
    key: string,
    now: number,
    window: number,
    limit: number
  ): Promise<void> {
    const r = await state.limit(scope, key, now, window, limit);
    if (!r.allowed) throw new AuthKitError("RATE_LIMITED", 429, r.retryAt);
  }

  async function allowed(user: any): Promise<boolean> {
    return (
      !!user &&
      user.enabled &&
      (options.isUserAllowed ? await options.isUserAllowed(user) : true)
    );
  }

  async function handle(
    request: Request,
    refreshSession = true
  ): Promise<Response> {
    let now = Date.now();
    try {
      const url = new URL(request.url);
      const path = url.pathname.startsWith(`${basePath}/`)
        ? url.pathname.slice(basePath.length)
        : "";
      if (
        !(
          (path === "/session" && request.method === "GET") ||
          (Object.hasOwn(bodies, path) && request.method === "POST")
        )
      )
        throw new AuthKitError("NOT_FOUND", 404);

      if (request.method === "POST") assertOrigin(request, options);

      const body: any =
        request.method === "POST"
          ? await parseBody(request, path as BodyPath)
          : {};

      const ip = await options.resolveClientIp(request);
      if (typeof ip !== "string" || !ip || ip.length > 128)
        throw new AuthKitError("UNAVAILABLE", 503);

      now = await state.now();
      const challenge = challengeCookie(options, request);

      const json = (data: unknown, headers?: Headers) => {
        const h = headers ?? new Headers();
        h.set("cache-control", "no-store");
        return Response.json(data, { headers: h });
      };

      if (path === "/captcha") {
        await enforce("captcha-ip", ip, now, 60000, 60);
        await enforce("captcha-app", "all", now, 60000, 1000);
        const captcha = svgCaptcha.create({
          size: 4,
          noise: 3,
          color: false,
          ignoreChars: "0oO1iIlL",
          width: 160,
          height: 56,
        });
        const id = randomUUID();
        await state.saveCaptcha(
          challenge.context,
          body.purpose,
          id,
          captcha.text,
          now
        );
        const headers = new Headers();
        headers.append("set-cookie", challenge.cookie);
        return json(
          {
            id,
            image: captcha.data,
            expiresAt: now + 120000,
            serverTime: now,
          },
          headers
        );
      }

      const phone = body.phoneNumber;
      if (path === "/sign-in/password") {
        await enforce("password-ip", ip, now, 300000, 100);
        if (body.email) {
          await enforce("password-email", body.email, now, 300000, 10);
        } else if (body.username) {
          await enforce("password-username", body.username, now, 300000, 10);
        } else {
          await enforce("password-phone", phone, now, 300000, 10);
        }
      }
      if (path === "/sign-in/sms" || path === "/password/reset") {
        await enforce("otp-ip", ip, now, 300000, 100);
        await enforce("otp-phone", phone, now, 300000, 15);
      }
      if (path === "/password/change")
        await enforce("password-change-ip", ip, now, 300000, 30);
      if (path === "/sms/send")
        await enforce("send-ip", ip, now, 3600000, 20);

      if (path === "/sign-in/password" || path === "/sms/send") {
        const purpose = path === "/sign-in/password" ? "password-login" : body.purpose;
        if (!body.captchaId || !body.captchaAnswer || !(await state.consumeCaptcha(
          challenge.context, purpose, body.captchaId, body.captchaAnswer, now,
        ))) throw new AuthKitError("CAPTCHA_INVALID", 400);
      }

      if (path === "/password/reset" || path === "/password/change") {
        try {
          validatePassword(body.newPassword);
        } catch {
          throw new AuthKitError("INVALID_INPUT", 400);
        }
      }

      return await withClient(request, path, body, now, ip, json, refreshSession);
    } catch (error) {
      return errorResponse(error, now);
    }
  }

  async function withClient(
    request: Request,
    path: string,
    body: any,
    now: number,
    ip: string,
    json: (data: unknown, headers?: Headers) => Response,
    refreshSession: boolean
  ): Promise<Response> {
    const client = await options.pool.connect();
    let heldKey: string | undefined;
    let broken = false;
    let transactionOpen = false;
    const begin = async () => {
      await client.query("BEGIN");
      transactionOpen = true;
    };
    const commit = async () => {
      await client.query("COMMIT");
      transactionOpen = false;
    };
    try {
      const db = drizzle(client);
      const { user, session, account } = options.schema;
      let userId: string | undefined;
      if (path === "/sign-in/password" && body.username) {
        userId = await options.resolveUsername?.(body.username) ?? undefined;
        if (!userId) {
          await verifyPassword({ hash: await dummyHash, password: body.password });
          throw new AuthKitError("INVALID_CREDENTIALS", 401);
        }
      }
      if (path === "/sign-in/password" && body.email) {
        const matches = await db.select().from(user).where(eq(user.email, body.email));
        userId = matches[0]?.id;
        if (!userId) {
          await verifyPassword({ hash: await dummyHash, password: body.password });
          throw new AuthKitError("INVALID_CREDENTIALS", 401);
        }
      }

      const framework = createFramework(options, client);
      const headers = new Headers(request.headers);
      headers.delete("x-forwarded-for");
      headers.delete("x-real-ip");
      headers.set("x-forwarded-for", ip);
      const { auth, run } = framework;
      const api = auth.api as any;
      const readSession = (): Promise<any> => run("/get-session", () => api.getSession({ headers, query: { disableRefresh: true } }));

      if (!body.phoneNumber && !userId) {
        const currentSession = await readSession();
        if (!currentSession) {
          if (path === "/sign-out") {
            const result: Response = await run("/sign-out", () => api.signOut({ headers, asResponse: true }));
            const responseHeaders = new Headers();
            for (const cookie of result.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie);
            return json({ status: true }, responseHeaders);
          }
          throw new AuthKitError("UNAUTHENTICATED", 401);
        }
        userId = currentSession.user.id;
      }
      const matches = await db.select().from(user).where(userId ? eq(user.id, userId) : eq(user.phoneNumber, body.phoneNumber));
      const identity = matches[0];
      // Every alias and account-management operation serializes on the stable user ID.
      heldKey = lockKey(options.appId, identity ? `user:${identity.id}` : `phone:${body.phoneNumber}`);
      await client.query("SELECT pg_advisory_lock($1::bigint)", [heldKey]);
      const current = identity ? (await db.select().from(user).where(eq(user.id, identity.id)))[0] : undefined;
      const activePhone = current?.phoneNumber ?? body.phoneNumber ?? null;
      const canLogin = (!body.phoneNumber || current?.phoneNumber === body.phoneNumber) && await allowed(current);
      if (path === "/sign-in/password" && current) await enforce("password-user", current.id, now, 300000, 10);

      if (path === "/session") {
        const result: any = await run("/get-session", () =>
          api.getSession({
            headers,
            query: { disableRefresh: !refreshSession },
            returnHeaders: true,
          })
        );
        const currentSession = result.response;
        if (!currentSession || !canLogin)
          throw new AuthKitError("UNAUTHENTICATED", 401);
        return json(
          {
            user: {
              id: currentSession.user.id,
              name: currentSession.user.name,
              phoneNumber: activePhone,
            },
            expiresAt: currentSession.session.expiresAt.toISOString(),
          },
          result.headers
        );
      }

      if (path === "/sign-out") {
        const currentSession = await readSession();
        if (currentSession?.session?.id) {
          await db
            .delete(session)
            .where(eq(session.id, currentSession.session.id));
        }
        const signOutRes: any = await run("/sign-out", () =>
          api.signOut({ headers, asResponse: true })
        );
        const responseHeaders = new Headers();
        for (const cookie of signOutRes.headers.getSetCookie()) {
          responseHeaders.append("set-cookie", cookie);
        }
        return json({ status: true }, responseHeaders);
      }

      if (path === "/sms/send") {
        now = await state.now();
        const quota = await state.reserveSend(activePhone, now, true);
        if (!quota.allowed)
          throw new AuthKitError("RATE_LIMITED", 429, quota.retryAt);
        const purpose = body.purpose;
        const action =
          purpose === "sms-login" ? "login.authenticate" : "password.reset";

        if (!canLogin || !current) {
          // Anonymous uniform response: do not disclose account presence or status
          const retryAt = await state.finishSend(activePhone, now);
          return json({ status: true, retryAt, serverTime: now });
        }

        try {
          const result = await options.sms.service.issue({
            subjectId: current.id,
            action,
            phone: activePhone,
            ipAddress: ip,
            idempotencyKey: `auth-kit:${options.appId}:${current.id}:${action}:${randomUUID()}`,
          });
          await state.setActiveChallenge(
            current.id,
            action,
            result.id,
            300_000
          );
        } catch (error: any) {
          if (error instanceof AuthKitError) throw error;
          const code = error?.code || error?.name;
          if (
            code === "RATE_LIMITED" ||
            code === "PROVIDER_THROTTLED" ||
            code === "PHONE_THROTTLED" ||
            code === "IP_THROTTLED"
          ) {
            throw new AuthKitError("RATE_LIMITED", 429);
          }
          throw new AuthKitError("UNAVAILABLE", 503);
        }

        now = await state.now();
        const retryAt = await state.finishSend(activePhone, now);
        return json({ status: true, retryAt, serverTime: now });
      }

      if (!canLogin || !current) {
        if (path === "/sign-in/password")
          await verifyPassword({
            hash: await dummyHash,
            password: body.password,
          });
        throw new AuthKitError(
          path === "/sign-in/password"
            ? "INVALID_CREDENTIALS"
            : path === "/password/change"
              ? "UNAUTHENTICATED"
              : "OTP_INVALID",
          path === "/sign-in/password" || path === "/password/change"
            ? 401
            : 400
        );
      }

      if (path === "/sign-in/password") {
        const accountRows = await db
          .select()
          .from(account)
          .where(
            and(
              eq(account.userId, current.id),
              eq(account.providerId, "credential")
            )
          );
        const cred = accountRows[0];
        if (!cred?.password) {
          await verifyPassword({
            hash: await dummyHash,
            password: body.password,
          });
          throw new AuthKitError("INVALID_CREDENTIALS", 401);
        }

        const valid =
          (await verifyPassword({
            hash: cred.password,
            password: body.password,
          })) ||
          (options.verifyLegacyPassword
            ? await options.verifyLegacyPassword({
                hash: cred.password,
                password: body.password,
              })
            : false);

        if (!valid) {
          throw new AuthKitError("INVALID_CREDENTIALS", 401);
        }

        const r: any = await run("/create-session-for-user", () =>
          api.createSessionForUser({
            headers,
            body: { userId: current.id },
            asResponse: true,
          })
        );
        return forward(r, json, "INVALID_CREDENTIALS");
      }

      if (path === "/password/change") {
        const currentSession = await readSession();
        if (!currentSession || currentSession.user.id !== current.id)
          throw new AuthKitError("UNAUTHENTICATED", 401);

        const accountRows = await db
          .select()
          .from(account)
          .where(
            and(
              eq(account.userId, current.id),
              eq(account.providerId, "credential")
            )
          );
        const cred = accountRows[0];
        if (!cred?.password) throw new AuthKitError("UNAUTHENTICATED", 401);

        const currentValid =
          (await verifyPassword({
            hash: cred.password,
            password: body.currentPassword,
          })) ||
          (options.verifyLegacyPassword
            ? await options.verifyLegacyPassword({
                hash: cred.password,
                password: body.currentPassword,
              })
            : false);

        if (!currentValid) throw new AuthKitError("INVALID_CREDENTIALS", 401);

        const newHash = await hashPassword(body.newPassword);
        await begin();
        await db
          .update(account)
          .set({ password: newHash, updatedAt: new Date() })
          .where(eq(account.id, cred.id));

        // Revoke ALL sessions for this user (both current and other devices)
        await db.delete(session).where(eq(session.userId, current.id));

        // Return expired session cookie headers
        const signOutRes: any = await run("/sign-out", () =>
          api.signOut({ headers, asResponse: true })
        );
        if (!signOutRes.ok) throw new AuthKitError("UNAVAILABLE", 503);
        await commit();
        const responseHeaders = new Headers();
        for (const cookie of signOutRes.headers.getSetCookie()) {
          responseHeaders.append("set-cookie", cookie);
        }
        return json({ status: true }, responseHeaders);
      }

      const purpose =
        path === "/sign-in/sms" ? "sms-login" : "password-reset";
      const action =
        purpose === "sms-login" ? "login.authenticate" : "password.reset";

      let challengeId = await state.getActiveChallenge(current.id, action);
      if (!challengeId) {
        try {
          const res = await client.query(
            "SELECT id FROM sms_kit.otp_challenge WHERE scope_type='SYSTEM' AND tenant_id IS NULL AND subject_id=$1 AND action=$2 AND invalidated_at IS NULL AND verified_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
            [current.id, action]
          );
          challengeId = res.rows[0]?.id;
        } catch {}
      }
      if (!challengeId) throw new AuthKitError("OTP_INVALID", 400);

      const newHash = path === "/password/reset" ? await hashPassword(body.newPassword) : undefined;
      await begin();
      const verified = await options.sms.service.verifyAndConsume({
        subjectId: current.id, action, challengeId, code: body.code,
        consumptionKey: `auth-kit:${purpose}:${randomUUID()}`,
      }, asSmsTransaction(client));
      if (!verified) {
        // No credential writes yet: retain failed-code attempts in the same transaction.
        await commit();
        throw new AuthKitError("OTP_INVALID", 400);
      }

      if (path === "/sign-in/sms") {
        const r: any = await run("/create-session-for-user", () =>
          api.createSessionForUser({
            headers,
            body: { userId: current.id },
            asResponse: true,
          })
        );
        const response = forward(r, json, "OTP_INVALID");
        await commit();
        return response;
      }

      // /password/reset
      const accountRows = await db
        .select()
        .from(account)
        .where(
          and(
            eq(account.userId, current.id),
            eq(account.providerId, "credential")
          )
        );
      const cred = accountRows[0];
      if (cred) {
        await db
          .update(account)
          .set({ password: newHash, updatedAt: new Date() })
          .where(eq(account.id, cred.id));
      } else {
        await db.insert(account).values({
          id: randomUUID(),
          userId: current.id,
          accountId: current.id,
          providerId: "credential",
          password: newHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Revoke ALL sessions for this user; do not auto sign-in
      await db.delete(session).where(eq(session.userId, current.id));

      const signOutRes: any = await run("/sign-out", () =>
        api.signOut({ headers, asResponse: true })
      );
      if (!signOutRes.ok) throw new AuthKitError("UNAVAILABLE", 503);
      await commit();
      const responseHeaders = new Headers();
      for (const cookie of signOutRes.headers.getSetCookie()) {
        responseHeaders.append("set-cookie", cookie);
      }
      return json({ status: true }, responseHeaders);
    } finally {
      if (transactionOpen) {
        try { await client.query("ROLLBACK"); }
        catch { broken = true; }
      }
      if (heldKey)
        try {
          await client.query("SELECT pg_advisory_unlock($1::bigint)", [
            heldKey,
          ]);
        } catch {
          broken = true;
        }
      client.release(broken);
    }
  }

  const handler = (request: Request) => handle(request);
  return {
    handler,
    async getSession(request: Request): Promise<AuthSession | null> {
      const url = new URL(request.url);
      url.pathname = `${basePath}/session`;
      url.search = "";
      const response = await handle(
        new Request(url, { headers: request.headers }),
        false
      );
      if (response.status === 401) return null;
      if (!response.ok) throw new AuthKitError("UNAVAILABLE", 503);
      return (await response.json()) as AuthSession;
    },
  };
}

function forward(
  response: any,
  json: (data: unknown, headers?: Headers) => Response,
  code: "UNAUTHENTICATED" | "INVALID_CREDENTIALS" | "OTP_INVALID"
): Response {
  if (!response.ok) {
    if (response.status >= 500) throw new AuthKitError("UNAVAILABLE", 503);
    throw new AuthKitError(code, code === "OTP_INVALID" ? 400 : 401);
  }
  const headers = new Headers();
  for (const cookie of response.headers.getSetCookie())
    headers.append("set-cookie", cookie);
  return json({ status: true }, headers);
}
