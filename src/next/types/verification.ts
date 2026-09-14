import { z } from "zod";

import { idempotencyKeySchema, versionSchema } from "./common.js";

const positiveInt = (min: number, max: number) => z.number().int().safe().min(min).max(max);

const verificationPolicyFields = {
  otpLength: positiveInt(4, 8),
  otpTtlSeconds: positiveInt(60, 900),
  otpMaxAttempts: positiveInt(1, 10),
  proofTtlSeconds: positiveInt(30, 900),
  phoneMinIntervalSeconds: positiveInt(1, 3_600),
  phoneHourlyLimit: positiveInt(1, 2_147_483_647),
  phoneDailyLimit: positiveInt(1, 2_147_483_647),
  ipWindowSeconds: positiveInt(60, 86_400),
  ipWindowLimit: positiveInt(1, 2_147_483_647),
  systemDailyBudget: positiveInt(1, 2_147_483_647).nullable(),
  circuitOpen: z.boolean(),
  /** This must always be operator-safe; provider text is never copied here. */
  circuitReason: z.string().trim().min(1).max(512).optional(),
};

const betterAuthTemplateKeySchema = z.string().trim().min(1).max(256)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

/**
 * Read-only host integration state. sms-kit does not invent or persist these
 * mappings: the host supplies the same snapshot used to build its Better Auth
 * adapter, and owns any adapter reconfiguration lifecycle.
 */
export const betterAuthVerificationDtoSchema = z.strictObject({
  adapterStatus: z.enum(["enabled", "disabled", "not_configured"]),
  loginTemplateKey: betterAuthTemplateKeySchema.nullable(),
  passwordResetTemplateKey: betterAuthTemplateKeySchema.nullable(),
}).superRefine((value, ctx) => {
  const hasBothMappings = value.loginTemplateKey !== null && value.passwordResetTemplateKey !== null;
  const hasNoMappings = value.loginTemplateKey === null && value.passwordResetTemplateKey === null;
  if (!hasBothMappings && !hasNoMappings) {
    ctx.addIssue({ code: "custom", path: ["loginTemplateKey"], message: "both Better Auth template mappings must be supplied together" });
  }
  if (value.adapterStatus === "enabled" && !hasBothMappings) {
    ctx.addIssue({ code: "custom", path: ["adapterStatus"], message: "enabled adapter requires both template mappings" });
  }
  if (value.adapterStatus === "not_configured" && !hasNoMappings) {
    ctx.addIssue({ code: "custom", path: ["adapterStatus"], message: "unconfigured adapter cannot expose template mappings" });
  }
});

export const verificationSettingsDtoSchema = z.strictObject({
  version: versionSchema,
  ...verificationPolicyFields,
  betterAuth: betterAuthVerificationDtoSchema,
})
  .superRefine((value, ctx) => {
    if (value.phoneDailyLimit < value.phoneHourlyLimit) ctx.addIssue({ code: "custom", path: ["phoneDailyLimit"], message: "must not be lower than phoneHourlyLimit" });
    if (value.circuitOpen && value.circuitReason === undefined) ctx.addIssue({ code: "custom", path: ["circuitReason"], message: "required when circuit is open" });
    if (!value.circuitOpen && value.circuitReason !== undefined) ctx.addIssue({ code: "custom", path: ["circuitReason"], message: "only allowed when circuit is open" });
  });

export const updateVerificationSettingsInputSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  ...verificationPolicyFields,
}).superRefine((value, ctx) => {
  if (value.phoneDailyLimit < value.phoneHourlyLimit) ctx.addIssue({ code: "custom", path: ["phoneDailyLimit"], message: "must not be lower than phoneHourlyLimit" });
  if (value.circuitOpen && value.circuitReason === undefined) ctx.addIssue({ code: "custom", path: ["circuitReason"], message: "required when circuit is open" });
  if (!value.circuitOpen && value.circuitReason !== undefined) ctx.addIssue({ code: "custom", path: ["circuitReason"], message: "only allowed when circuit is open" });
});

export type VerificationSettingsDto = z.infer<typeof verificationSettingsDtoSchema>;
export type BetterAuthVerificationDto = z.infer<typeof betterAuthVerificationDtoSchema>;
export type UpdateVerificationSettingsInput = z.infer<typeof updateVerificationSettingsInputSchema>;
