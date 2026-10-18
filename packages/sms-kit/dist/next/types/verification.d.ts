import { z } from "zod";
/**
 * Read-only host integration state. sms-kit does not invent or persist these
 * mappings: the host supplies the same snapshot used to build its Better Auth
 * adapter, and owns any adapter reconfiguration lifecycle.
 */
export declare const betterAuthVerificationDtoSchema: z.ZodObject<{
    adapterStatus: z.ZodEnum<{
        disabled: "disabled";
        enabled: "enabled";
        not_configured: "not_configured";
    }>;
    loginTemplateKey: z.ZodNullable<z.ZodString>;
    passwordResetTemplateKey: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export declare const verificationSettingsDtoSchema: z.ZodObject<{
    otpLength: z.ZodNumber;
    otpTtlSeconds: z.ZodNumber;
    otpMaxAttempts: z.ZodNumber;
    proofTtlSeconds: z.ZodNumber;
    phoneMinIntervalSeconds: z.ZodNumber;
    phoneHourlyLimit: z.ZodNumber;
    phoneDailyLimit: z.ZodNumber;
    ipWindowSeconds: z.ZodNumber;
    ipWindowLimit: z.ZodNumber;
    systemDailyBudget: z.ZodNullable<z.ZodNumber>;
    circuitOpen: z.ZodBoolean;
    circuitReason: z.ZodOptional<z.ZodString>;
    version: z.ZodNumber;
    betterAuth: z.ZodObject<{
        adapterStatus: z.ZodEnum<{
            disabled: "disabled";
            enabled: "enabled";
            not_configured: "not_configured";
        }>;
        loginTemplateKey: z.ZodNullable<z.ZodString>;
        passwordResetTemplateKey: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const updateVerificationSettingsInputSchema: z.ZodObject<{
    otpLength: z.ZodNumber;
    otpTtlSeconds: z.ZodNumber;
    otpMaxAttempts: z.ZodNumber;
    proofTtlSeconds: z.ZodNumber;
    phoneMinIntervalSeconds: z.ZodNumber;
    phoneHourlyLimit: z.ZodNumber;
    phoneDailyLimit: z.ZodNumber;
    ipWindowSeconds: z.ZodNumber;
    ipWindowLimit: z.ZodNumber;
    systemDailyBudget: z.ZodNullable<z.ZodNumber>;
    circuitOpen: z.ZodBoolean;
    circuitReason: z.ZodOptional<z.ZodString>;
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export type VerificationSettingsDto = z.infer<typeof verificationSettingsDtoSchema>;
export type BetterAuthVerificationDto = z.infer<typeof betterAuthVerificationDtoSchema>;
export type UpdateVerificationSettingsInput = z.infer<typeof updateVerificationSettingsInputSchema>;
