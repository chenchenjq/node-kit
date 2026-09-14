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

export const verificationSettingsDtoSchema = z.strictObject({ version: versionSchema, ...verificationPolicyFields })
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
export type UpdateVerificationSettingsInput = z.infer<typeof updateVerificationSettingsInputSchema>;
