import type { PoolClient } from "pg";
import type { AuthKitOptions } from "./options.js";
import { hashPassword } from "./password.js";
/** Package-private: no raw auth instance/options/context is exported by auth-kit. */
export declare function createFramework(options: AuthKitOptions, client: PoolClient, send: (phone: string, code: string, purpose: "sms-login" | "password-reset") => Promise<void>): {
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
            id: "phone-number";
            version: string;
            init(): {
                options: {
                    databaseHooks: {
                        user: {
                            update: {
                                before(data: Partial<{
                                    id: string;
                                    createdAt: Date;
                                    updatedAt: Date;
                                    email: string;
                                    emailVerified: boolean;
                                    name: string;
                                    image?: string | null | undefined;
                                }> & Record<string, unknown>): Promise<{
                                    data: {
                                        [x: string]: unknown;
                                        id?: string | undefined;
                                        createdAt?: Date | undefined;
                                        updatedAt?: Date | undefined;
                                        email?: string | undefined;
                                        emailVerified?: boolean | undefined;
                                        name?: string | undefined;
                                        image?: string | null | undefined;
                                    };
                                } | undefined>;
                            };
                        };
                    };
                };
            };
            hooks: {
                before: {
                    matcher: (ctx: import("better-auth").HookEndpointContext) => boolean;
                    handler: import("better-auth").Middleware<import("better-auth").MiddlewareOptions, (inputContext: import("better-auth").MiddlewareInputContext<import("better-auth").MiddlewareOptions>) => Promise<never>>;
                }[];
            };
            endpoints: {
                signInPhoneNumber: import("better-auth").StrictEndpoint<"/sign-in/phone-number", {
                    method: "POST";
                    body: import("better-auth").ZodObject<{
                        phoneNumber: import("better-auth").ZodString;
                        password: import("better-auth").ZodString;
                        rememberMe: import("better-auth").ZodOptional<import("better-auth").ZodBoolean>;
                    }, import("zod/v4/core").$strip>;
                    metadata: {
                        openapi: {
                            summary: string;
                            description: string;
                            responses: {
                                200: {
                                    description: string;
                                    content: {
                                        "application/json": {
                                            schema: {
                                                type: "object";
                                                properties: {
                                                    user: {
                                                        $ref: string;
                                                    };
                                                    session: {
                                                        $ref: string;
                                                    };
                                                };
                                            };
                                        };
                                    };
                                };
                                400: {
                                    description: string;
                                };
                            };
                        };
                    };
                }, {
                    token: string;
                    user: import("better-auth/plugins").UserWithPhoneNumber;
                }>;
                sendPhoneNumberOTP: import("better-auth").StrictEndpoint<"/phone-number/send-otp", {
                    method: "POST";
                    body: import("better-auth").ZodObject<{
                        phoneNumber: import("better-auth").ZodString;
                    }, import("zod/v4/core").$strip>;
                    metadata: {
                        openapi: {
                            summary: string;
                            description: string;
                            responses: {
                                200: {
                                    description: string;
                                    content: {
                                        "application/json": {
                                            schema: {
                                                type: "object";
                                                properties: {
                                                    message: {
                                                        type: string;
                                                    };
                                                };
                                            };
                                        };
                                    };
                                };
                            };
                        };
                    };
                }, {
                    message: string;
                }>;
                consumePhoneNumberOTP: import("better-auth").StrictEndpoint<string, {
                    method: "POST";
                    body: import("better-auth").ZodObject<{
                        phoneNumber: import("better-auth").ZodString;
                        code: import("better-auth").ZodString;
                    }, import("zod/v4/core").$strip>;
                    metadata: {
                        readonly scope: "server";
                    };
                }, {
                    status: boolean;
                }>;
                verifyPhoneNumber: import("better-auth").StrictEndpoint<"/phone-number/verify", {
                    method: "POST";
                    body: import("better-auth").ZodIntersection<import("better-auth").ZodObject<{
                        phoneNumber: import("better-auth").ZodString;
                        code: import("better-auth").ZodString;
                        disableSession: import("better-auth").ZodOptional<import("better-auth").ZodBoolean>;
                        updatePhoneNumber: import("better-auth").ZodOptional<import("better-auth").ZodBoolean>;
                    }, import("zod/v4/core").$strip>, import("better-auth").ZodRecord<import("better-auth").ZodString, import("better-auth").ZodAny>>;
                    metadata: {
                        openapi: {
                            summary: string;
                            description: string;
                            responses: {
                                "200": {
                                    description: string;
                                    content: {
                                        "application/json": {
                                            schema: {
                                                type: "object";
                                                properties: {
                                                    status: {
                                                        type: string;
                                                        description: string;
                                                        enum: boolean[];
                                                    };
                                                    token: {
                                                        type: string;
                                                        nullable: boolean;
                                                        description: string;
                                                    };
                                                    user: {
                                                        type: string;
                                                        nullable: boolean;
                                                        properties: {
                                                            id: {
                                                                type: string;
                                                                description: string;
                                                            };
                                                            email: {
                                                                type: string;
                                                                format: string;
                                                                nullable: boolean;
                                                                description: string;
                                                            };
                                                            emailVerified: {
                                                                type: string;
                                                                nullable: boolean;
                                                                description: string;
                                                            };
                                                            name: {
                                                                type: string;
                                                                nullable: boolean;
                                                                description: string;
                                                            };
                                                            image: {
                                                                type: string;
                                                                format: string;
                                                                nullable: boolean;
                                                                description: string;
                                                            };
                                                            phoneNumber: {
                                                                type: string;
                                                                description: string;
                                                            };
                                                            phoneNumberVerified: {
                                                                type: string;
                                                                description: string;
                                                            };
                                                            createdAt: {
                                                                type: string;
                                                                format: string;
                                                                description: string;
                                                            };
                                                            updatedAt: {
                                                                type: string;
                                                                format: string;
                                                                description: string;
                                                            };
                                                        };
                                                        required: string[];
                                                        description: string;
                                                    };
                                                };
                                                required: string[];
                                            };
                                        };
                                    };
                                };
                                400: {
                                    description: string;
                                };
                            };
                        };
                    };
                }, {
                    status: boolean;
                    token: string;
                    user: {
                        id: string;
                        createdAt: Date;
                        updatedAt: Date;
                        email: string;
                        emailVerified: boolean;
                        name: string;
                        image?: string | null | undefined;
                    } & import("better-auth/plugins").UserWithPhoneNumber;
                } | {
                    status: boolean;
                    token: null;
                    user: import("better-auth/plugins").UserWithPhoneNumber;
                }>;
                requestPasswordResetPhoneNumber: import("better-auth").StrictEndpoint<"/phone-number/request-password-reset", {
                    method: "POST";
                    body: import("better-auth").ZodObject<{
                        phoneNumber: import("better-auth").ZodString;
                    }, import("zod/v4/core").$strip>;
                    metadata: {
                        openapi: {
                            description: string;
                            responses: {
                                "200": {
                                    description: string;
                                    content: {
                                        "application/json": {
                                            schema: {
                                                type: "object";
                                                properties: {
                                                    status: {
                                                        type: string;
                                                        description: string;
                                                        enum: boolean[];
                                                    };
                                                };
                                                required: string[];
                                            };
                                        };
                                    };
                                };
                            };
                        };
                    };
                }, {
                    status: boolean;
                }>;
                resetPasswordPhoneNumber: import("better-auth").StrictEndpoint<"/phone-number/reset-password", {
                    method: "POST";
                    body: import("better-auth").ZodObject<{
                        otp: import("better-auth").ZodString;
                        phoneNumber: import("better-auth").ZodString;
                        newPassword: import("better-auth").ZodString;
                    }, import("zod/v4/core").$strip>;
                    metadata: {
                        openapi: {
                            description: string;
                            responses: {
                                "200": {
                                    description: string;
                                    content: {
                                        "application/json": {
                                            schema: {
                                                type: "object";
                                                properties: {
                                                    status: {
                                                        type: string;
                                                        description: string;
                                                        enum: boolean[];
                                                    };
                                                };
                                                required: string[];
                                            };
                                        };
                                    };
                                };
                            };
                        };
                    };
                }, {
                    status: boolean;
                }>;
            };
            schema: {
                user: {
                    fields: {
                        phoneNumber: {
                            type: "string";
                            required: false;
                            unique: true;
                            sortable: true;
                            returned: true;
                        };
                        phoneNumberVerified: {
                            type: "boolean";
                            required: false;
                            returned: true;
                            input: false;
                        };
                    };
                };
            };
            rateLimit: {
                pathMatcher(path: string): boolean;
                window: number;
                max: number;
            }[];
            options: import("better-auth/plugins").PhoneNumberOptions | undefined;
            $ERROR_CODES: {
                OTP_EXPIRED: import("better-auth").RawError<"OTP_EXPIRED">;
                INVALID_OTP: import("better-auth").RawError<"INVALID_OTP">;
                TOO_MANY_ATTEMPTS: import("better-auth").RawError<"TOO_MANY_ATTEMPTS">;
                INVALID_PHONE_NUMBER: import("better-auth").RawError<"INVALID_PHONE_NUMBER">;
                PHONE_NUMBER_EXIST: import("better-auth").RawError<"PHONE_NUMBER_EXIST">;
                PHONE_NUMBER_NOT_EXIST: import("better-auth").RawError<"PHONE_NUMBER_NOT_EXIST">;
                INVALID_PHONE_NUMBER_OR_PASSWORD: import("better-auth").RawError<"INVALID_PHONE_NUMBER_OR_PASSWORD">;
                UNEXPECTED_ERROR: import("better-auth").RawError<"UNEXPECTED_ERROR">;
                OTP_NOT_FOUND: import("better-auth").RawError<"OTP_NOT_FOUND">;
                PHONE_NUMBER_NOT_VERIFIED: import("better-auth").RawError<"PHONE_NUMBER_NOT_VERIFIED">;
                PHONE_NUMBER_CANNOT_BE_UPDATED: import("better-auth").RawError<"PHONE_NUMBER_CANNOT_BE_UPDATED">;
                SEND_OTP_NOT_IMPLEMENTED: import("better-auth").RawError<"SEND_OTP_NOT_IMPLEMENTED">;
            };
        }];
        hooks: {
            before: import("better-auth").Middleware<import("better-auth").MiddlewareOptions, (inputContext: import("better-auth").MiddlewareInputContext<import("better-auth").MiddlewareOptions>) => Promise<void>>;
        };
    }>;
    run: <T>(path: string, work: () => Promise<T>) => Promise<T>;
};
