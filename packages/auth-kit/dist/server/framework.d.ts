import { z } from "zod";
import type { PoolClient } from "pg";
import { hashPassword } from "./password.js";
import type { AuthKitOptions } from "./options.js";
/** Package-private: no raw auth instance/options/context is exported by auth-kit. */
export declare function createFramework(options: AuthKitOptions, client: PoolClient): {
    auth: import("better-auth").Auth<{
        appName: string;
        baseURL: string;
        basePath: string;
        secret: string;
        database: (options: import("better-auth").BetterAuthOptions) => import("better-auth").DBAdapter;
        trustedOrigins: string[];
        logger: {
            disabled: true;
        };
        emailAndPassword: {
            enabled: true;
            disableSignUp: true;
            minPasswordLength: number;
            maxPasswordLength: number;
            autoSignIn: false;
            revokeSessionsOnPasswordReset: true;
            password: {
                hash: typeof hashPassword;
                verify: (input: {
                    hash: string;
                    password: string;
                }) => Promise<boolean>;
            };
        };
        user: {
            additionalFields: {
                enabled: {
                    type: "boolean";
                    defaultValue: true;
                    input: false;
                };
            };
        };
        session: {
            cookieCache: {
                enabled: false;
            };
            freshAge: number;
        };
        advanced: {
            cookiePrefix: string;
            useSecureCookies: boolean;
            disableCSRFCheck: false;
            disableOriginCheck: false;
        };
        plugins: [{
            id: "auth-kit-system-session";
            endpoints: {
                createSessionForUser: import("better-auth").StrictEndpoint<"/create-session-for-user", {
                    method: "POST";
                    body: z.ZodObject<{
                        userId: z.ZodString;
                    }, z.core.$strip>;
                }, {
                    status: boolean;
                    session: {
                        id: string;
                        createdAt: Date;
                        updatedAt: Date;
                        userId: string;
                        expiresAt: Date;
                        token: string;
                        ipAddress?: string | null | undefined;
                        userAgent?: string | null | undefined;
                    };
                    user: any;
                }>;
            };
        }];
        hooks: {
            before: import("better-auth").Middleware<import("better-auth").MiddlewareOptions, (inputContext: import("better-auth").MiddlewareInputContext<import("better-auth").MiddlewareOptions>) => Promise<void>>;
        };
    }>;
    run: <T>(path: string, work: () => Promise<T>) => Promise<T>;
};
