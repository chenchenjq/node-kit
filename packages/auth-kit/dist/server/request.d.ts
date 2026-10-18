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
        captchaId: z.ZodOptional<z.ZodString>;
        captchaAnswer: z.ZodOptional<z.ZodString>;
        phoneNumber: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        purpose: z.ZodEnum<{
            "password-reset": "password-reset";
            "sms-login": "sms-login";
        }>;
    }, z.core.$strip>;
    "/sign-in/password": z.ZodPipe<z.ZodObject<{
        captchaId: z.ZodOptional<z.ZodString>;
        captchaAnswer: z.ZodOptional<z.ZodString>;
        loginId: z.ZodOptional<z.ZodString>;
        phoneNumber: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
        password: z.ZodString;
    }, z.core.$strip>, z.ZodTransform<{
        captchaId?: string | undefined;
        captchaAnswer?: string | undefined;
        loginId?: string | undefined;
        phoneNumber?: string | undefined;
        password: string;
        username: undefined;
    } | {
        captchaId?: string | undefined;
        captchaAnswer?: string | undefined;
        loginId?: string | undefined;
        password: string;
        email: string;
        username: undefined;
        phoneNumber: undefined;
    } | {
        captchaId?: string | undefined;
        captchaAnswer?: string | undefined;
        loginId?: string | undefined;
        password: string;
        username: string;
        phoneNumber: undefined;
    }, {
        captchaId?: string | undefined;
        captchaAnswer?: string | undefined;
        loginId?: string | undefined;
        phoneNumber?: string | undefined;
        password: string;
    }>>;
    "/sign-in/sms": z.ZodObject<{
        phoneNumber: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        code: z.ZodString;
    }, z.core.$strip>;
    "/password/reset": z.ZodObject<{
        phoneNumber: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        code: z.ZodString;
        newPassword: z.ZodString;
    }, z.core.$strip>;
    "/password/change": z.ZodObject<{
        currentPassword: z.ZodString;
        newPassword: z.ZodString;
    }, z.core.$strip>;
    "/sign-out": z.ZodObject<{}, z.core.$strip>;
};
export type BodyPath = keyof typeof bodies;
export type ParsedBody<P extends BodyPath> = z.infer<(typeof bodies)[P]>;
export declare function parseBody<P extends BodyPath>(request: Request, path: P): Promise<ParsedBody<P>>;
export declare function assertOrigin(request: Request, options: AuthKitOptions): void;
export declare function challengeCookie(options: AuthKitOptions, request: Request): {
    context: string;
    cookie: string;
};
