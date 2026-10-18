import { SmsKitError } from "../../core/errors.js";
import { resourceSyncCommitResultDtoSchema, resourceSyncPreviewDtoSchema, signatureDtoSchema, signaturePageDtoSchema, templateDtoSchema, templatePageDtoSchema, } from "../types/index.js";
function requireService(value) {
    if (value === undefined)
        throw new SmsKitError("STORAGE_FAILURE", "admin route service is unavailable");
    return value;
}
function candidate(candidate, expiresAt) {
    const base = {
        id: candidate.id, resourceType: candidate.resourceType, externalKey: candidate.externalKey,
        changeType: candidate.changeType, checksum: candidate.checksum, expiresAt: expiresAt.toISOString(),
    };
    return candidate.resourceType === "signature" ? {
        ...base,
        resourceType: "signature",
        snapshot: {
            kind: "signature",
            externalName: candidate.snapshot.externalName,
            externalStatus: candidate.snapshot.externalStatus,
            externalType: candidate.snapshot.externalType,
        },
    } : {
        ...base,
        resourceType: "template",
        snapshot: {
            kind: "template",
            externalName: candidate.snapshot.externalName,
            externalStatus: candidate.snapshot.externalStatus,
            templateType: candidate.snapshot.templateType,
            variableNames: candidate.snapshot.variableNames,
        },
    };
}
export function signatureDto(value) {
    return signatureDtoSchema.parse({ id: value.id, externalKey: value.externalKey, externalName: value.externalName, externalStatus: value.externalStatus, externalType: value.externalType, enabled: value.enabled, version: value.version });
}
export function templateDto(value) {
    return templateDtoSchema.parse({
        id: value.id, signatureId: value.signatureId, templateKey: value.templateKey, externalCode: value.externalCode,
        externalName: value.externalName, externalStatus: value.externalStatus, templateType: value.templateType,
        purpose: value.purpose, variables: value.variables.map((variable) => ({ name: variable.name, sensitive: variable.sensitive })), enabled: value.enabled, version: value.version,
    });
}
export async function resourceRoute(services, actor, path, body, params, query) {
    if (path === "/resources/sync-preview") {
        const input = body;
        const preview = await requireService(services.resourceSync).preview(actor, {
            ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
            expectedVersion: input.version,
            idempotencyKey: input.idempotencyKey,
        });
        return resourceSyncPreviewDtoSchema.parse({ id: preview.id, status: preview.status, expiresAt: preview.expiresAt.toISOString(), candidates: preview.candidates.map((item) => candidate(item, preview.expiresAt)) });
    }
    if (path === "/resources/sync-commit") {
        const input = body;
        const result = await requireService(services.resourceSync).commit(actor, {
            syncId: input.syncId,
            candidates: input.candidates,
            expectedVersion: input.version,
            idempotencyKey: input.idempotencyKey,
        });
        return resourceSyncCommitResultDtoSchema.parse({ id: result.id, status: result.status === "running" ? "partial" : result.status, expiresAt: result.expiresAt.toISOString(), importedCount: result.candidates.length, candidates: result.candidates.map((item) => candidate(item, result.expiresAt)) });
    }
    if (path === "/signatures") {
        const result = await requireService(services.resources).listSignatures(actor, { page: query.page, pageSize: query.pageSize });
        return signaturePageDtoSchema.parse({ items: result.items.map(signatureDto), page: query.page, pageSize: query.pageSize, total: result.total });
    }
    if (path === "/signatures/:id")
        return signatureDto(await requireService(services.resources).updateSignature(actor, { id: params.id, ...body }));
    if (path === "/templates") {
        const result = await requireService(services.resources).listTemplates(actor, { page: query.page, pageSize: query.pageSize });
        return templatePageDtoSchema.parse({ items: result.items.map(templateDto), page: query.page, pageSize: query.pageSize, total: result.total });
    }
    if (path === "/templates/import")
        return templateDto(await requireService(services.resources).importTemplate(actor, body));
    if (path === "/templates/:id") {
        const input = body;
        return templateDto(await requireService(services.resources).updateTemplate(actor, {
            id: params.id,
            version: input.version,
            idempotencyKey: input.idempotencyKey,
            ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        }));
    }
    return undefined;
}
