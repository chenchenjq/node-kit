import { z } from "zod";
import type { AuthKitOptions } from "./options.js";
export declare const bodies: {
    "/captcha": z.ZodObject<{
        purpose: z.ZodEnum<{
            "password-login": "password-login";
            "password-reset": "password-reset";
            "sms-login": "sms-login";
        }>;
    }, z.core.$strip>;
    "/sms/send": z.ZodObject<{
        captchaId: z.ZodString;
        captchaAnswer: z.ZodString;
        phoneNumber: z.ZodPipe<z.ZodString, z.ZodTransform<import("sms-kit/core").MainlandPhone, string>>;
        purpose: z.ZodEnum<{
            "password-reset": "password-reset";
            "sms-login": "sms-login";
        }>;
    }, z.core.$strip>;
    "/sign-in/password": z.ZodObject<{
        captchaId: z.ZodString;
        captchaAnswer: z.ZodString;
        phoneNumber: z.ZodPipe<z.ZodString, z.ZodTransform<import("sms-kit/core").MainlandPhone, string>>;
        password: z.ZodString;
    }, z.core.$strip>;
    "/sign-in/sms": z.ZodObject<{
        phoneNumber: z.ZodPipe<z.ZodString, z.ZodTransform<import("sms-kit/core").MainlandPhone, string>>;
        code: z.ZodString;
    }, z.core.$strip>;
    "/password/reset": z.ZodObject<{
        phoneNumber: z.ZodPipe<z.ZodString, z.ZodTransform<import("sms-kit/core").MainlandPhone, string>>;
        code: z.ZodString;
        newPassword: z.ZodString;
    }, z.core.$strip>;
    "/password/change": z.ZodObject<{
        currentPassword: z.ZodString;
        newPassword: z.ZodString;
    }, z.core.$strip>;
    "/sign-out": z.ZodObject<{}, z.core.$strip>;
};
export type WritePath = keyof typeof bodies;
export declare function parseBody(request: Request, path: WritePath): Promise<Record<string, string>>;
export declare function assertOrigin(request: Request, options: AuthKitOptions): void;
export declare function challengeCookie(options: AuthKitOptions, request: Request): {
    context: string;
    cookie: string;
};
