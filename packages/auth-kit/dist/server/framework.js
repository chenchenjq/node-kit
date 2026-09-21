import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { phoneNumber } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { credentialAdapter } from "./database.js";
import { hashPassword, verifyPassword } from "./password.js";
/** Package-private: no raw auth instance/options/context is exported by auth-kit. */
export function createFramework(options, client, send) {
    const gate = new AsyncLocalStorage();
    const auth = betterAuth({
        appName: options.appId,
        baseURL: options.baseURL,
        basePath: "/api/auth-kit-internal",
        secret: options.secret,
        database: credentialAdapter(client, options.schema),
        trustedOrigins: [options.baseURL],
        logger: { disabled: true },
        emailAndPassword: {
            enabled: true,
            disableSignUp: true,
            minPasswordLength: 8,
            maxPasswordLength: 128,
            autoSignIn: false,
            revokeSessionsOnPasswordReset: true,
            password: {
                hash: hashPassword,
                verify: async (input) => (await verifyPassword(input)) ||
                    (options.verifyLegacyPassword
                        ? await options.verifyLegacyPassword(input)
                        : false),
            },
        },
        user: {
            additionalFields: {
                enabled: { type: "boolean", defaultValue: true, input: false },
            },
        },
        session: { cookieCache: { enabled: false }, freshAge: 0 },
        advanced: {
            cookiePrefix: `auth-kit-${options.appId}`,
            useSecureCookies: new URL(options.baseURL).protocol === "https:",
            disableCSRFCheck: false,
            disableOriginCheck: false,
        },
        plugins: [
            phoneNumber({
                otpLength: 6,
                expiresIn: 300,
                allowedAttempts: 3,
                requireVerification: false,
                sendOTP: async ({ phoneNumber, code }) => send(phoneNumber, code, "sms-login"),
                sendPasswordResetOTP: async ({ phoneNumber, code }) => send(phoneNumber, code, "password-reset"),
            }),
        ],
        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                // disabledPaths applies to HTTP only. This capability guard also covers auth.api/server-only endpoints.
                if (!gate.getStore() || gate.getStore() !== ctx.path)
                    throw new APIError("FORBIDDEN", {
                        code: "FORBIDDEN",
                        message: "Protected auth-kit entry required",
                    });
            }),
        },
    });
    return {
        auth,
        run: (path, work) => gate.run(path, work),
    };
}
