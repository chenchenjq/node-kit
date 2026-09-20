import { randomUUID, createHash } from "node:crypto";
import svgCaptcha from "svg-captcha";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import { AuthKitError, errorResponse } from "./errors.js";
import { SecurityState } from "./state.js";
import { validatePassword, hashPassword, verifyPassword } from "./password.js";
import { createFramework } from "./framework.js";
import { assertOrigin, bodies, challengeCookie, parseBody, } from "./request.js";
function lockKey(app, phone) {
    return createHash("sha256")
        .update(`${app}:${phone}`)
        .digest()
        .readBigInt64BE()
        .toString();
}
function identifier(phone, purpose) {
    return purpose === "sms-login" ? phone : `${phone}-request-password-reset`;
}
function validateOptions(options) {
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(options.appId) ||
        typeof options.secret !== "string" ||
        options.secret.length < 32)
        throw new Error("appId and an auth secret of at least 32 characters are required");
    const url = new URL(options.baseURL);
    if (url.origin !== options.baseURL ||
        !(url.protocol === "https:" ||
            (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
        throw new Error("baseURL must be an exact HTTPS public origin (HTTP loopback is allowed for development)");
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(options.basePath ?? "/api/auth-kit") ||
        (options.basePath ?? "").endsWith("/"))
        throw new Error("Invalid basePath");
    if (!options.sms.tenantId ||
        typeof options.resolveClientIp !== "function" ||
        options.wechat?.enabled)
        throw new Error("Invalid host configuration");
}
export function createAuthKit(options) {
    validateOptions(options);
    const basePath = options.basePath ?? "/api/auth-kit";
    const state = new SecurityState(options.redis, options.appId, options.secret);
    const dummyHash = hashPassword("AuthKitDummyPassword1!");
    async function enforce(scope, key, now, window, limit) {
        const r = await state.limit(scope, key, now, window, limit);
        if (!r.allowed)
            throw new AuthKitError("RATE_LIMITED", 429, r.retryAt);
    }
    async function allowed(user) {
        return (!!user &&
            user.enabled &&
            (options.isUserAllowed ? await options.isUserAllowed(user) : true));
    }
    async function handle(request, refreshSession = true) {
        let now = Date.now();
        try {
            const url = new URL(request.url);
            const path = url.pathname.startsWith(`${basePath}/`)
                ? url.pathname.slice(basePath.length)
                : "";
            if (!((path === "/session" && request.method === "GET") ||
                (Object.hasOwn(bodies, path) && request.method === "POST")))
                throw new AuthKitError("NOT_FOUND", 404);
            if (request.method === "POST")
                assertOrigin(request, options);
            const body = request.method === "POST"
                ? await parseBody(request, path)
                : {};
            const ip = await options.resolveClientIp(request);
            if (typeof ip !== "string" || !ip || ip.length > 128)
                throw new AuthKitError("UNAVAILABLE", 503);
            now = await state.now();
            const challenge = challengeCookie(options, request);
            const json = (data, headers) => {
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
                await state.saveCaptcha(challenge.context, body.purpose, id, captcha.text, now);
                const headers = new Headers();
                headers.append("set-cookie", challenge.cookie);
                return json({ id, image: captcha.data, expiresAt: now + 120000, serverTime: now }, headers);
            }
            const phone = body.phoneNumber;
            if (path === "/sign-in/password") {
                await enforce("password-ip", ip, now, 300000, 100);
                await enforce("password-phone", phone, now, 300000, 10);
            }
            if (path === "/sign-in/sms" || path === "/password/reset") {
                await enforce("otp-ip", ip, now, 300000, 100);
                await enforce("otp-phone", phone, now, 300000, 15);
            }
            if (path === "/password/change")
                await enforce("password-change-ip", ip, now, 300000, 30);
            if (path === "/sms/send")
                await enforce("send-ip", ip, now, 300000, 30);
            if (path === "/sms/send" || path === "/sign-in/password") {
                const purpose = path === "/sms/send"
                    ? body.purpose
                    : "password-login";
                if (!(await state.consumeCaptcha(challenge.context, purpose, body.captchaId, body.captchaAnswer, now)))
                    throw new AuthKitError("CAPTCHA_INVALID", 400);
            }
            if (path === "/password/reset" || path === "/password/change") {
                try {
                    validatePassword(body.newPassword);
                }
                catch {
                    throw new AuthKitError("INVALID_INPUT", 400);
                }
            }
            return await withClient(request, path, body, now, json, refreshSession);
        }
        catch (error) {
            return errorResponse(error, now);
        }
    }
    async function withClient(request, path, body, now, json, refreshSession) {
        const client = await options.pool.connect();
        let heldKey;
        let broken = false;
        try {
            const db = drizzle(client);
            const { user, verification } = options.schema;
            let activePhone = body.phoneNumber;
            let sendAllowed = false;
            const framework = createFramework(options, client, async (phone, code, purpose) => {
                if (!sendAllowed)
                    return;
                const issuance = (await db
                    .select()
                    .from(verification)
                    .where(eq(verification.identifier, identifier(phone, purpose))))[0];
                if (!issuance || issuance.expiresAt.getTime() <= (await state.now()))
                    throw new Error("Missing framework issuance");
                const message = await options.sms.sendService.sendOtpNow({
                    tenantId: options.sms.tenantId,
                    phone,
                    variables: { code },
                    purpose: purpose === "sms-login"
                        ? "better-auth:login"
                        : "better-auth:passwordReset",
                    templateKey: purpose === "sms-login"
                        ? (options.sms.templates?.login ?? "auth.login_otp")
                        : (options.sms.templates?.passwordReset ??
                            "auth.password_reset"),
                    idempotencyKey: `auth-kit:${options.appId}:${randomUUID()}`,
                });
                if (message.acceptanceStatus !== "accepted")
                    throw new Error("SMS not accepted");
                await state.acceptDelivery(identifier(phone, purpose), issuance.expiresAt.getTime());
            });
            const headers = new Headers(request.headers);
            // Supply only the host-verified IP to the framework; caller forwarded headers are discarded.
            headers.delete("x-forwarded-for");
            headers.delete("x-real-ip");
            headers.set("x-forwarded-for", await options.resolveClientIp(request));
            const { auth, run } = framework;
            const readSession = () => run("/get-session", () => auth.api.getSession({ headers, query: { disableRefresh: true } }));
            if (!activePhone) {
                const session = await readSession();
                if (!session) {
                    if (path === "/sign-out")
                        return json({ status: true });
                    throw new AuthKitError("UNAUTHENTICATED", 401);
                }
                const rows = await db
                    .select()
                    .from(user)
                    .where(eq(user.id, session.user.id));
                activePhone = rows[0]?.phoneNumber;
                if (!activePhone || (!(await allowed(rows[0])) && path !== "/sign-out"))
                    throw new AuthKitError("UNAUTHENTICATED", 401);
            }
            heldKey = lockKey(options.appId, activePhone);
            // Session-level PostgreSQL locks do not expire mid-request. OTP failures persist; no rollback of attempt counts.
            await client.query("SELECT pg_advisory_lock($1::bigint)", [heldKey]);
            const rows = await db
                .select()
                .from(user)
                .where(eq(user.phoneNumber, activePhone));
            const current = rows[0];
            const canLogin = await allowed(current);
            if (path === "/session") {
                const result = await run("/get-session", () => auth.api.getSession({
                    headers,
                    query: { disableRefresh: !refreshSession },
                    returnHeaders: true,
                }));
                const session = result.response;
                if (!session || !canLogin)
                    throw new AuthKitError("UNAUTHENTICATED", 401);
                return json({
                    user: {
                        id: session.user.id,
                        name: session.user.name,
                        phoneNumber: activePhone,
                    },
                    expiresAt: session.session.expiresAt.toISOString(),
                }, result.headers);
            }
            if (path === "/sign-out") {
                const r = await run("/sign-out", () => auth.api.signOut({ headers, asResponse: true }));
                return forward(r, json, "UNAUTHENTICATED");
            }
            if (path === "/sms/send") {
                now = await state.now();
                const quota = await state.reserveSend(activePhone, now, true);
                if (!quota.allowed)
                    throw new AuthKitError("RATE_LIMITED", 429, quota.retryAt);
                const purpose = body.purpose;
                const id = identifier(activePhone, purpose);
                await state.clearDelivery(id);
                await db.delete(verification).where(eq(verification.identifier, id));
                sendAllowed = canLogin;
                let delivered = false;
                try {
                    const r = purpose === "sms-login"
                        ? await run("/phone-number/send-otp", () => auth.api.sendPhoneNumberOTP({
                            headers,
                            body: { phoneNumber: activePhone },
                            asResponse: true,
                        }))
                        : await run("/phone-number/request-password-reset", () => auth.api.requestPasswordResetPhoneNumber({
                            headers,
                            body: { phoneNumber: activePhone },
                            asResponse: true,
                        }));
                    delivered = canLogin && r.ok;
                }
                catch {
                    /* Same public receipt for absent/disabled accounts and delivery rejection/timeout. */
                }
                if (!delivered)
                    await db.delete(verification).where(eq(verification.identifier, id));
                now = await state.now();
                const retryAt = await state.finishSend(activePhone, now);
                return json({ status: true, retryAt, serverTime: now });
            }
            if (!canLogin) {
                if (path === "/sign-in/password")
                    await verifyPassword({
                        hash: await dummyHash,
                        password: body.password,
                    });
                throw new AuthKitError(path === "/sign-in/password"
                    ? "INVALID_CREDENTIALS"
                    : path === "/password/change"
                        ? "UNAUTHENTICATED"
                        : "OTP_INVALID", path === "/sign-in/password" || path === "/password/change"
                    ? 401
                    : 400);
            }
            if (path === "/sign-in/password")
                return forward(await run("/sign-in/phone-number", () => auth.api.signInPhoneNumber({
                    headers,
                    body: { phoneNumber: activePhone, password: body.password },
                    asResponse: true,
                })), json, "INVALID_CREDENTIALS");
            if (path === "/password/change") {
                // Re-read after the phone lock: a reset/sign-out may have revoked this session while waiting.
                const s = await readSession();
                if (!s || s.user.id !== current.id)
                    throw new AuthKitError("UNAUTHENTICATED", 401);
                return forward(await run("/change-password", () => auth.api.changePassword({
                    headers,
                    body: {
                        currentPassword: body.currentPassword,
                        newPassword: body.newPassword,
                        revokeOtherSessions: true,
                    },
                    asResponse: true,
                })), json, "INVALID_CREDENTIALS");
            }
            const purpose = path === "/sign-in/sms" ? "sms-login" : "password-reset";
            const existing = await db
                .select()
                .from(verification)
                .where(and(eq(verification.identifier, identifier(activePhone, purpose))));
            now = await state.now();
            if (!existing[0] ||
                existing[0].expiresAt.getTime() <= now ||
                !(await state.deliveryAccepted(identifier(activePhone, purpose), existing[0].expiresAt.getTime())))
                throw new AuthKitError("OTP_INVALID", 400);
            if (path === "/sign-in/sms")
                return forward(await run("/phone-number/verify", () => auth.api.verifyPhoneNumber({
                    headers,
                    body: {
                        phoneNumber: activePhone,
                        code: body.code,
                        disableSession: false,
                        updatePhoneNumber: false,
                    },
                    asResponse: true,
                })), json, "OTP_INVALID");
            return forward(await run("/phone-number/reset-password", () => auth.api.resetPasswordPhoneNumber({
                headers,
                body: {
                    phoneNumber: activePhone,
                    otp: body.code,
                    newPassword: body.newPassword,
                },
                asResponse: true,
            })), json, "OTP_INVALID");
        }
        finally {
            if (heldKey)
                try {
                    await client.query("SELECT pg_advisory_unlock($1::bigint)", [
                        heldKey,
                    ]);
                }
                catch {
                    broken = true;
                }
            client.release(broken);
        }
    }
    const handler = (request) => handle(request);
    return {
        handler,
        async getSession(request) {
            const url = new URL(request.url);
            url.pathname = `${basePath}/session`;
            url.search = "";
            const response = await handle(new Request(url, { headers: request.headers }), false);
            if (response.status === 401)
                return null;
            if (!response.ok)
                throw new AuthKitError("UNAVAILABLE", 503);
            return (await response.json());
        },
    };
}
function forward(response, json, code) {
    if (!response.ok) {
        if (response.status >= 500)
            throw new AuthKitError("UNAVAILABLE", 503);
        throw new AuthKitError(code, code === "OTP_INVALID" ? 400 : 401);
    }
    const headers = new Headers();
    for (const cookie of response.headers.getSetCookie())
        headers.append("set-cookie", cookie);
    // Session tokens remain in HttpOnly cookies, never in public response JSON.
    return json({ status: true }, headers);
}
