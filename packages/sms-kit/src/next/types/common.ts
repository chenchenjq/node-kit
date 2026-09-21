import { z } from "zod";

/** Stable public error codes. Provider-specific codes never cross this boundary. */
export const smsErrorCodeSchema = z.enum([
  "CONFIG_INVALID",
  "SECRET_UNRESOLVABLE",
  "PERMISSION_DENIED",
  "SIGNATURE_UNAVAILABLE",
  "TEMPLATE_UNAVAILABLE",
  "TEMPLATE_VARIABLE_INVALID",
  "RATE_LIMITED",
  "BUDGET_EXCEEDED",
  "CIRCUIT_OPEN",
  "PROVIDER_REJECTED",
  "PROVIDER_THROTTLED",
  "PROVIDER_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
  "CONCURRENT_MODIFICATION",
  "CHALLENGE_EXPIRED",
  "CHALLENGE_ATTEMPTS_EXCEEDED",
  "PROOF_INVALID",
  "ACCEPTANCE_UNKNOWN",
  "DELIVERY_UNKNOWN",
  "STORAGE_FAILURE",
]);

export type SmsErrorCode = z.infer<typeof smsErrorCodeSchema>;

export const requestIdSchema = z.string().trim().min(1);
export const identifierSchema = z.string().trim().min(1).max(256);
/** IDs backed by PostgreSQL uuid columns are checked before they reach a query. */
export const uuidSchema = z.uuid();
export const idempotencyKeySchema = z.string().trim().min(1).max(512);
export const versionSchema = z.number().int().safe().nonnegative();
export const positiveVersionSchema = z.number().int().safe().positive();
/** Public times are normalized by the server and serialized as UTC ISO-8601. */
export const isoDateTimeSchema = z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), {
  message: "timestamp must be UTC",
});
export const safeCountSchema = z.union([
  z.number().int().safe().nonnegative(),
  z.string().regex(/^(?:0|[1-9][0-9]*)$/),
]);

export const apiFailureSchema = z.strictObject({
  error: z.strictObject({
    code: smsErrorCodeSchema,
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    retryable: z.boolean(),
  }),
  requestId: requestIdSchema,
});

export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({ data, requestId: requestIdSchema });
}

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    page: z.number().int().positive(),
    pageSize: z.number().int().min(1).max(100),
    total: safeCountSchema,
  });
}

export const versionedWriteSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
});

export type ApiSuccess<T> = Readonly<{ data: T; requestId: string }>;
export type ApiFailure = z.infer<typeof apiFailureSchema>;
export type PageDto<T> = Readonly<{ items: T[]; page: number; pageSize: number; total: number | string }>;
export type VersionedWrite = z.infer<typeof versionedWriteSchema>;
