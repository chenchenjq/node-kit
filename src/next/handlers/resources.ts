import type { ResourceSyncService } from "../../application/resource-sync-service.js";
import { SmsKitError } from "../../core/errors.js";
import type { AuthorizationActor } from "../../ports/security.js";
import type { Signature, Template } from "../../ports/store.js";
import {
  resourceSyncCommitResultDtoSchema,
  resourceSyncPreviewDtoSchema,
  signatureDtoSchema,
  signaturePageDtoSchema,
  templateDtoSchema,
  templatePageDtoSchema,
  type ImportTemplateInput,
  type ResourceSyncCommitInput,
  type ResourceSyncPreviewInput,
  type UpdateSignatureInput,
  type UpdateTemplateInput,
} from "../types/index.js";

export type SmsResourceAdminService<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  listSignatures(input: Readonly<{ page: number; pageSize: number }>): Promise<{ items: readonly Signature[]; total: number }>;
  updateSignature(actor: Actor, input: Readonly<{ id: string } & UpdateSignatureInput>): Promise<Signature>;
  listTemplates(input: Readonly<{ page: number; pageSize: number }>): Promise<{ items: readonly Template[]; total: number }>;
  importTemplate(actor: Actor, input: ImportTemplateInput): Promise<Template>;
  updateTemplate(actor: Actor, input: Readonly<{ id: string } & UpdateTemplateInput>): Promise<Template>;
}>;

export type SmsResourceRouteServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  resourceSync?: Pick<ResourceSyncService<Actor>, "preview" | "commit">;
  resources?: SmsResourceAdminService<Actor>;
}>;

function requireService<T>(value: T | undefined): T {
  if (value === undefined) throw new SmsKitError("STORAGE_FAILURE", "admin route service is unavailable");
  return value;
}

function candidate(candidate: { id: string; resourceType: "signature" | "template"; externalKey: string; changeType: "new" | "changed" | "unavailable" | "unchanged"; checksum: string }, expiresAt: Date) {
  return { id: candidate.id, resourceType: candidate.resourceType, externalKey: candidate.externalKey, changeType: candidate.changeType, checksum: candidate.checksum, expiresAt: expiresAt.toISOString() };
}

export function signatureDto(value: Signature) {
  return signatureDtoSchema.parse({ id: value.id, externalKey: value.externalKey, externalName: value.externalName, externalStatus: value.externalStatus, externalType: value.externalType, enabled: value.enabled, version: value.version });
}

export function templateDto(value: Template) {
  return templateDtoSchema.parse({
    id: value.id, signatureId: value.signatureId, templateKey: value.templateKey, externalCode: value.externalCode,
    externalName: value.externalName, externalStatus: value.externalStatus, templateType: value.templateType,
    purpose: value.purpose, variables: value.variables.map((variable) => ({ name: variable.name, sensitive: variable.sensitive })), enabled: value.enabled, version: value.version,
  });
}

export async function resourceRoute<Actor extends AuthorizationActor>(
  services: SmsResourceRouteServices<Actor>, actor: Actor, path: string,
  body: unknown, params: Readonly<Record<string, string>>, query: Readonly<Record<string, unknown>>,
): Promise<unknown | undefined> {
  if (path === "/resources/sync-preview") {
    const input = body as ResourceSyncPreviewInput;
    const preview = await requireService(services.resourceSync).preview(actor, {
      ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
      ...(input.templates === undefined ? {} : { templates: input.templates }),
    });
    return resourceSyncPreviewDtoSchema.parse({ id: preview.id, status: preview.status, expiresAt: preview.expiresAt.toISOString(), candidates: preview.candidates.map((item) => candidate(item, preview.expiresAt)) });
  }
  if (path === "/resources/sync-commit") {
    const result = await requireService(services.resourceSync).commit(actor, body as ResourceSyncCommitInput);
    return resourceSyncCommitResultDtoSchema.parse({ id: result.id, status: result.status === "running" ? "partial" : result.status, expiresAt: result.expiresAt.toISOString(), importedCount: result.candidates.length, candidates: result.candidates.map((item) => candidate(item, result.expiresAt)) });
  }
  if (path === "/signatures") {
    const result = await requireService(services.resources).listSignatures({ page: query.page as number, pageSize: query.pageSize as number });
    return signaturePageDtoSchema.parse({ items: result.items.map(signatureDto), page: query.page, pageSize: query.pageSize, total: result.total });
  }
  if (path === "/signatures/:id") return signatureDto(await requireService(services.resources).updateSignature(actor, { id: params.id!, ...(body as UpdateSignatureInput) }));
  if (path === "/templates") {
    const result = await requireService(services.resources).listTemplates({ page: query.page as number, pageSize: query.pageSize as number });
    return templatePageDtoSchema.parse({ items: result.items.map(templateDto), page: query.page, pageSize: query.pageSize, total: result.total });
  }
  if (path === "/templates/import") return templateDto(await requireService(services.resources).importTemplate(actor, body as ImportTemplateInput));
  if (path === "/templates/:id") return templateDto(await requireService(services.resources).updateTemplate(actor, { id: params.id!, ...(body as UpdateTemplateInput) }));
  return undefined;
}
