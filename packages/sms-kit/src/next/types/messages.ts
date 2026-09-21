import { z } from "zod";

import { idempotencyKeySchema, identifierSchema, isoDateTimeSchema, pageSchema, positiveVersionSchema, safeCountSchema, smsErrorCodeSchema } from "./common.js";

export const acceptanceStatusSchema = z.enum(["pending", "accepted", "rejected", "unknown"]);
export const deliveryStatusSchema = z.enum(["not_applicable", "waiting", "delivered", "failed", "unknown_final"]);
export const phoneDtoSchema = z.strictObject({
  masked: z.string().regex(/^(?:1[3-9][0-9])?\*{3,}[0-9]{4}$/).nullable(),
  last4Available: z.boolean(),
});

export const messageDtoSchema = z.strictObject({
  id: identifierSchema,
  phone: phoneDtoSchema,
  templateKey: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  acceptanceStatus: acceptanceStatusSchema,
  deliveryStatus: deliveryStatusSchema,
  submittedAt: isoDateTimeSchema,
  attemptCount: safeCountSchema,
  providerBizId: z.string().trim().min(1).optional(),
  finalErrorCode: smsErrorCodeSchema.optional(),
});

const providerRequestIdSchema = z.string().trim().min(1).max(512);
const redactedFieldSchema = z.enum(["phone", "otp", "proof", "secret", "template-params"]);
const safeMetricNameSchema = z.enum([
  "attempt", "job", "message", "receipt", "resource", "rate-limit", "signature", "template",
]);
const eventDiagnosticsDtoSchema = z.strictObject({
  redactedFields: z.array(redactedFieldSchema).max(16).optional(),
  counts: z.array(z.strictObject({
    name: safeMetricNameSchema,
    value: z.number().int().safe().nonnegative(),
  })).max(32).optional(),
});
const receiptDiagnosticsDtoSchema = z.strictObject({
  redactedFields: z.array(redactedFieldSchema).max(16),
  reportCount: safeCountSchema.optional(),
});
const attemptTimelineItemDtoSchema = z.strictObject({
  attemptNo: z.number().int().safe().positive(),
  status: z.enum(["started", "accepted", "rejected", "unknown"]),
  dispatchMode: z.enum(["direct", "queued"]),
  dispatchMarkedAt: isoDateTimeSchema,
  occurredAt: isoDateTimeSchema,
  providerRequestId: providerRequestIdSchema.optional(),
  errorCode: smsErrorCodeSchema.optional(),
  latencyMs: z.number().int().safe().nonnegative().optional(),
});
const receiptTimelineItemDtoSchema = z.strictObject({
  source: z.enum(["callback", "query"]),
  deliveryStatus: z.enum(["delivered", "failed"]),
  occurredAt: isoDateTimeSchema,
  receivedAt: isoDateTimeSchema,
  diagnostics: receiptDiagnosticsDtoSchema,
});

export const messageDetailDtoSchema = z.strictObject({
  ...messageDtoSchema.shape,
  /** The message-local optimistic version used by manual reconciliation. */
  version: positiveVersionSchema,
  acceptedAt: isoDateTimeSchema.optional(),
  deliveredAt: isoDateTimeSchema.optional(),
  finalizedAt: isoDateTimeSchema.optional(),
  providerRequestId: providerRequestIdSchema.optional(),
  attempts: z.array(attemptTimelineItemDtoSchema).max(1_000),
  receipts: z.array(receiptTimelineItemDtoSchema).max(1_000),
  diagnostics: eventDiagnosticsDtoSchema,
});

export const messagePageDtoSchema = pageSchema(messageDtoSchema);
export const messageQuerySchema = z.strictObject({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  acceptanceStatus: acceptanceStatusSchema.optional(),
  deliveryStatus: deliveryStatusSchema.optional(),
  templateKey: z.string().trim().min(1).max(256).optional(),
  purpose: z.string().trim().min(1).max(256).optional(),
  phone: z.string().trim().min(1).max(64).optional(),
}).superRefine((value, ctx) => {
  if ((value.from === undefined) !== (value.to === undefined)) {
    ctx.addIssue({ code: "custom", path: [value.from === undefined ? "from" : "to"], message: "from and to must be supplied together" });
  }
});

export const receiptHealthDtoSchema = z.strictObject({
  status: z.enum(["ready", "degraded", "disabled", "unconfigured"]),
  lastReceiptAt: isoDateTimeSchema.optional(),
  pendingJobs: safeCountSchema,
  acceptanceUnknown: safeCountSchema,
  deliveryUnknownFinal: safeCountSchema,
  unmatchedCount: safeCountSchema,
  systemBudgetRemaining: safeCountSchema.nullable(),
  circuitOpen: z.boolean(),
  warnings: z.array(smsErrorCodeSchema),
});

export const reconcileInputSchema = z.strictObject({
  version: positiveVersionSchema,
  idempotencyKey: idempotencyKeySchema,
  messageId: identifierSchema.optional(),
  providerBizId: z.string().trim().min(1).max(128).optional(),
}).superRefine((value, ctx) => {
  if (value.messageId === undefined && value.providerBizId === undefined) {
    ctx.addIssue({ code: "custom", path: [], message: "messageId or providerBizId is required" });
  }
});

export const jobStateSchema = z.enum(["pending", "leased", "succeeded", "failed", "dead"]);
export const jobTypeSchema = z.enum(["send", "dispatch_recovery", "reconcile", "retention", "rollup"]);
export const jobDtoSchema = z.strictObject({
  id: identifierSchema,
  jobType: jobTypeSchema,
  state: jobStateSchema,
  messageId: identifierSchema.optional(),
  availableAt: isoDateTimeSchema,
  attemptCount: safeCountSchema,
  maxAttempts: safeCountSchema,
  lastErrorCode: smsErrorCodeSchema.optional(),
});

export const smsStatsDtoSchema = z.strictObject({
  submitted: safeCountSchema,
  accepted: safeCountSchema,
  acceptanceRejected: safeCountSchema,
  acceptanceUnknown: safeCountSchema,
  deliveryWaiting: safeCountSchema,
  delivered: safeCountSchema,
  deliveryFailed: safeCountSchema,
  deliveryUnknownFinal: safeCountSchema,
  retry: safeCountSchema,
  acceptanceRate: z.number().min(0).max(1).optional(),
  deliveryRate: z.number().min(0).max(1).optional(),
});

export const statsQuerySchema = z.strictObject({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  templateKey: z.string().trim().min(1).max(256).optional(),
  purpose: z.string().trim().min(1).max(256).optional(),
  acceptanceStatus: acceptanceStatusSchema.optional(),
  deliveryStatus: deliveryStatusSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.from === undefined) !== (value.to === undefined)) {
    ctx.addIssue({ code: "custom", path: [value.from === undefined ? "from" : "to"], message: "from and to must be supplied together" });
  }
});

export type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type PhoneDto = z.infer<typeof phoneDtoSchema>;
export type MessageDto = z.infer<typeof messageDtoSchema>;
export type MessageDetailDto = z.infer<typeof messageDetailDtoSchema>;
export type MessageQuery = z.infer<typeof messageQuerySchema>;
export type ReceiptHealthDto = z.infer<typeof receiptHealthDtoSchema>;
export type ReconcileInput = z.infer<typeof reconcileInputSchema>;
export type JobState = z.infer<typeof jobStateSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobDto = z.infer<typeof jobDtoSchema>;
export type SmsStatsDto = z.infer<typeof smsStatsDtoSchema>;
export type StatsQuery = z.infer<typeof statsQuerySchema>;
