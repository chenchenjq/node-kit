import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { PoolClient } from "pg";
import { credentialAdapter } from "./database.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { AuthKitOptions } from "./options.js";

/** Package-private: no raw auth instance/options/context is exported by auth-kit. */
export function createFramework(
  options: AuthKitOptions,
  client: PoolClient
) {
  const gate = new AsyncLocalStorage<string>();
  const auth = betterAuth({
    appName: options.appId,
    baseURL: options.baseURL,
    basePath: "/api/auth-kit-internal",
    secret: options.secret,
    database: credentialAdapter(client, options.schema),
    trustedOrigins: [options.baseURL, ...(options.developmentOrigins ?? [])],
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
        verify: async (input) =>
          (await verifyPassword(input)) ||
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
      {
        id: "auth-kit-system-session",
        endpoints: {
          createSessionForUser: createAuthEndpoint(
            "/create-session-for-user",
            {
              method: "POST",
              body: z.object({ userId: z.string() }),
            },
            async (ctx) => {
              const user = (await ctx.context.internalAdapter.findUserById(
                ctx.body.userId
              )) as any;
              if (!user)
                throw new APIError("NOT_FOUND", {
                  code: "NOT_FOUND",
                  message: "User not found",
                });
              const session =
                await ctx.context.internalAdapter.createSession(user.id);
              if (!session)
                throw new APIError("INTERNAL_SERVER_ERROR", {
                  code: "INTERNAL_SERVER_ERROR",
                  message: "Failed to create session",
                });
              await setSessionCookie(ctx, { session, user });
              return ctx.json({ status: true, session, user });
            }
          ),
        },
      },
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
    run: <T>(path: string, work: () => Promise<T>): Promise<T> =>
      gate.run(path, work),
  };
}
