import { z } from "zod";

import { isProviderEndpointOrigin } from "../../core/provider-endpoint.js";
import { idempotencyKeySchema, isoDateTimeSchema, safeCountSchema, smsErrorCodeSchema, versionedWriteSchema, versionSchema } from "./common.js";

export const secretRefDtoSchema = z.strictObject({
  scheme: z.string().trim().min(1).max(64)
    .regex(/^[a-z][a-z0-9+.-]*$/, "secret reference scheme must be a lowercase URI scheme identifier"),
  maskedName: z.string().trim().min(3).max(256)
    .regex(
      /^(?:\*{3}|[A-Z][A-Z0-9]{0,7}_\*{3}_[A-Z][A-Z0-9]{0,7})$/,
      "secret reference name must be *** or SHORT_***_LABEL using uppercase alphanumeric labels",
    ),
  configured: z.boolean(),
});

export const providerConfigStatusSchema = z.enum(["unconfigured", "untested", "ready", "degraded", "disabled"]);

const providerEndpointSchema = z.string().max(2_048).refine(isProviderEndpointOrigin, {
  message: "provider endpoint must be an HTTPS origin without userinfo, path, query parameters, or a fragment",
});

export const providerConfigDtoSchema = z.discriminatedUnion("status", [
  z.strictObject({
    provider: z.literal("aliyun"),
    status: z.literal("unconfigured"),
    enabled: z.literal(false),
    lastTestStatus: z.literal("never"),
    version: versionSchema,
  }),
  z.strictObject({
    provider: z.literal("aliyun"),
    status: z.enum(["untested", "ready", "degraded", "disabled"]),
    enabled: z.boolean(),
    region: z.string().trim().min(1),
    endpoint: providerEndpointSchema.optional(),
    accessKeyIdRef: secretRefDtoSchema,
    accessKeySecretRef: secretRefDtoSchema,
    receiptCallbackTokenRef: secretRefDtoSchema,
    lastTestStatus: z.enum(["never", "succeeded", "failed"]),
    lastTestedAt: isoDateTimeSchema.optional(),
    version: versionSchema,
  }),
]);

/** Request references are opaque pointers; their resolved values are never DTOs. */
const secretReferenceInputSchema = z.string().trim().max(1_024)
  .regex(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/, "secret reference must include a scheme");
export const updateProviderConfigSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  provider: z.literal("aliyun").optional(),
  region: z.string().trim().min(1),
  endpoint: providerEndpointSchema.optional(),
  accessKeyIdRef: secretReferenceInputSchema,
  accessKeySecretRef: secretReferenceInputSchema,
  receiptCallbackTokenRef: secretReferenceInputSchema.optional(),
  enabled: z.boolean().optional(),
});

export const connectionTestResultDtoSchema = z.strictObject({
  status: z.enum(["succeeded", "failed"]),
  testedAt: isoDateTimeSchema,
  signatureCount: safeCountSchema,
  templateCount: safeCountSchema,
  config: providerConfigDtoSchema,
});

/** Connection tests write a versioned result, so retries need their own key. */
export const testConnectionInputSchema = versionedWriteSchema;

export const testSendInputSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  phone: z.string().trim().min(1).max(64),
  templateKey: z.string().trim().min(1).max(256),
  variables: z.record(z.string(), z.string()).default({}),
  purpose: z.string().trim().min(1).max(256),
});

export const smsOverviewDtoSchema = z.strictObject({
  status: z.enum(["ready", "degraded", "disabled", "unconfigured"]),
  providerStatus: providerConfigStatusSchema,
  pendingJobs: safeCountSchema,
  acceptanceUnknown: safeCountSchema,
  deliveryUnknown: safeCountSchema,
  unmatchedCount: safeCountSchema,
  systemBudgetRemaining: safeCountSchema.nullable(),
  circuitOpen: z.boolean(),
  warnings: z.array(smsErrorCodeSchema),
});

export type SecretRefDto = z.infer<typeof secretRefDtoSchema>;
export type ProviderConfigStatus = z.infer<typeof providerConfigStatusSchema>;
export type ProviderConfigDto = z.infer<typeof providerConfigDtoSchema>;
export type UpdateProviderConfigInput = z.infer<typeof updateProviderConfigSchema>;
export type ConnectionTestResultDto = z.infer<typeof connectionTestResultDtoSchema>;
export type TestConnectionInput = z.infer<typeof testConnectionInputSchema>;
export type TestSendInput = z.infer<typeof testSendInputSchema>;
export type SmsOverviewDto = z.infer<typeof smsOverviewDtoSchema>;
