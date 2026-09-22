import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { normalizeMainlandPhone } from "sms-kit/core";
import { AuthKitError } from "./errors.js";
const phone = z
    .string()
    .max(64)
    .transform((value, ctx) => {
    try {
        return normalizeMainlandPhone(value);
    }
    catch {
        ctx.addIssue({ code: "custom", message: "Invalid phone" });
        return z.NEVER;
    }
});
const graphic = {
    captchaId: z.string().min(16).max(128),
    captchaAnswer: z.string().min(1).max(16),
};
const password = z.string().min(1).max(1024); // old passwords are not subject to the NEW password policy
export const bodies = {
    "/captcha": z.object({
        purpose: z.enum(["password-login", "sms-login", "password-reset"]),
    }),
    "/sms/send": z.object({
        phoneNumber: phone,
        purpose: z.enum(["sms-login", "password-reset"]),
        ...graphic,
    }),
    "/sign-in/password": z.object({ phoneNumber: phone, password, ...graphic }),
    "/sign-in/sms": z.object({
        phoneNumber: phone,
        code: z.string().regex(/^\d{6}$/),
    }),
    "/password/reset": z.object({
        phoneNumber: phone,
        code: z.string().regex(/^\d{6}$/),
        newPassword: z.string().max(128),
    }),
    "/password/change": z.object({
        currentPassword: password,
        newPassword: z.string().max(128),
    }),
    "/sign-out": z.object({}),
};
export async function parseBody(request, path) {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json")
        throw new AuthKitError("INVALID_INPUT", 400);
    const reader = request.body?.getReader();
    if (!reader)
        throw new AuthKitError("INVALID_INPUT", 400);
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 8192) {
                await reader.cancel();
                throw new AuthKitError("INVALID_INPUT", 400);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new AuthKitError("INVALID_INPUT", 400);
    }
    const result = bodies[path].safeParse(parsed);
    if (!result.success)
        throw new AuthKitError("INVALID_INPUT", 400);
    return result.data;
}
export function assertOrigin(request, options) {
    if (request.headers.get("origin") !== options.baseURL)
        throw new AuthKitError("FORBIDDEN", 403);
    if (request.headers.get("sec-fetch-site") === "cross-site")
        throw new AuthKitError("FORBIDDEN", 403);
}
export function challengeCookie(options, request) {
    const name = `auth-kit-${options.appId}.challenge`;
    const sign = (value) => createHmac("sha256", options.secret)
        .update(`challenge:${options.appId}:${value}`)
        .digest("hex");
    const found = request.headers
        .get("cookie")
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(`${name}=`))
        ?.slice(name.length + 1);
    let context = "";
    if (found && /^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(found)) {
        const [id, signature] = found.split(".");
        if (id &&
            signature &&
            timingSafeEqual(Buffer.from(signature), Buffer.from(sign(id))))
            context = id;
    }
    if (!context)
        context = randomBytes(32).toString("hex");
    return {
        context,
        cookie: `${name}=${context}.${sign(context)}; Path=${options.basePath ?? "/api/auth-kit"}; HttpOnly; SameSite=Strict; Max-Age=86400${new URL(options.baseURL).protocol === "https:" ? "; Secure" : ""}`,
    };
}
