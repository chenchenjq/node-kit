import { z } from "zod";

import { idempotencyKeySchema, identifierSchema, isoDateTimeSchema, pageSchema, safeCountSchema, uuidSchema, versionSchema } from "./common.js";

export const resourceChangeTypeSchema = z.enum(["new", "changed", "unavailable", "unchanged"]);
export const resourceTypeSchema = z.enum(["signature", "template"]);
const resourceCandidateBaseShape = {
  id: identifierSchema,
  externalKey: z.string().trim().min(1),
  changeType: resourceChangeTypeSchema,
  checksum: z.string().trim().min(1),
  expiresAt: isoDateTimeSchema,
};
export const resourceCandidateDtoSchema = z.discriminatedUnion("resourceType", [
  z.strictObject({
    ...resourceCandidateBaseShape,
    resourceType: z.literal("signature"),
    snapshot: z.strictObject({
      kind: z.literal("signature"),
      externalName: z.string().trim().min(1),
      externalStatus: z.string().trim().min(1),
      externalType: z.string().trim().min(1),
    }),
  }),
  z.strictObject({
    ...resourceCandidateBaseShape,
    resourceType: z.literal("template"),
    snapshot: z.strictObject({
      kind: z.literal("template"),
      externalName: z.string().trim().min(1),
      externalStatus: z.string().trim().min(1),
      templateType: z.enum(["verification", "notification"]),
      variableNames: z.array(z.string().trim().min(1)),
    }),
  }),
]);

export const resourceSyncPreviewDtoSchema = z.strictObject({
  id: identifierSchema,
  status: z.enum(["running", "succeeded", "partial", "failed"]),
  expiresAt: isoDateTimeSchema,
  candidates: z.array(resourceCandidateDtoSchema),
});

export const resourceSyncPreviewInputSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  pageSize: z.number().int().min(1).max(100).optional(),
});

export const resourceSyncCommitInputSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  syncId: uuidSchema,
  candidates: z.array(z.strictObject({ id: uuidSchema, checksum: z.string().trim().min(1) })).min(1),
});

export const resourceSyncCommitResultDtoSchema = z.strictObject({
  id: identifierSchema,
  status: z.enum(["succeeded", "partial", "failed"]),
  expiresAt: isoDateTimeSchema,
  importedCount: safeCountSchema,
  candidates: z.array(resourceCandidateDtoSchema),
});

export const signatureDtoSchema = z.strictObject({
  id: identifierSchema,
  externalKey: z.string().trim().min(1),
  externalName: z.string().trim().min(1),
  externalStatus: z.string().trim().min(1),
  externalType: z.string().trim().min(1),
  enabled: z.boolean(),
  version: versionSchema,
});

export const updateSignatureInputSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  enabled: z.boolean(),
});

export const templateVariableDtoSchema = z.strictObject({ name: z.string().trim().min(1), sensitive: z.boolean() });
export const templateDtoSchema = z.strictObject({
  id: identifierSchema,
  signatureId: identifierSchema,
  templateKey: z.string().trim().min(1),
  externalCode: z.string().trim().min(1),
  externalName: z.string().trim().min(1),
  externalStatus: z.string().trim().min(1),
  templateType: z.enum(["verification", "notification"]),
  purpose: z.string().trim().min(1),
  variables: z.array(templateVariableDtoSchema),
  enabled: z.boolean(),
  version: versionSchema,
});

export const importTemplateInputSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  candidateId: uuidSchema,
  checksum: z.string().trim().min(1),
  templateKey: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  signatureExternalKey: z.string().trim().min(1),
});

export const updateTemplateInputSchema = z.strictObject({
  version: versionSchema,
  idempotencyKey: idempotencyKeySchema,
  /** Renames are accepted only for unused keys; the resource service fences used keys with CONCURRENT_MODIFICATION. */
  templateKey: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  purpose: z.string().trim().min(1).optional(),
}).refine((value) => value.templateKey !== undefined || value.enabled !== undefined || value.purpose !== undefined, {
  message: "at least one template field must be updated",
});

export const signaturePageDtoSchema = pageSchema(signatureDtoSchema);
export const templatePageDtoSchema = pageSchema(templateDtoSchema);

export type ResourceCandidateDto = z.infer<typeof resourceCandidateDtoSchema>;
export type ResourceSyncPreviewDto = z.infer<typeof resourceSyncPreviewDtoSchema>;
export type ResourceSyncPreviewInput = z.infer<typeof resourceSyncPreviewInputSchema>;
export type ResourceSyncCommitInput = z.infer<typeof resourceSyncCommitInputSchema>;
export type ResourceSyncCommitResultDto = z.infer<typeof resourceSyncCommitResultDtoSchema>;
export type SignatureDto = z.infer<typeof signatureDtoSchema>;
export type UpdateSignatureInput = z.infer<typeof updateSignatureInputSchema>;
export type TemplateVariableDto = z.infer<typeof templateVariableDtoSchema>;
export type TemplateDto = z.infer<typeof templateDtoSchema>;
export type ImportTemplateInput = z.infer<typeof importTemplateInputSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateInputSchema>;
