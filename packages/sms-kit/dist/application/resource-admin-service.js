import { SmsKitError } from "../core/errors.js";
import { validateTemplateKey } from "../core/template.js";
import { SYSTEM_SCOPE } from "../core/types.js";
import { executeAdminOperation } from "./admin-operation.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new TypeError("invalid resource snapshot");
    return value;
}
function text(value, name) {
    const result = value[name];
    if (typeof result !== "string" || result.length === 0)
        throw new TypeError(`invalid ${name}`);
    return result;
}
function version(value) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError("invalid version");
    return value;
}
function signatureSnapshot(value) {
    return {
        kind: "signature",
        id: value.id,
        externalKey: value.externalKey,
        externalName: value.externalName,
        externalStatus: value.externalStatus,
        externalType: value.externalType,
        enabled: value.enabled,
        version: value.version,
    };
}
function signatureFromSnapshot(value) {
    if (value.kind !== "signature" || typeof value.enabled !== "boolean")
        throw new TypeError("invalid signature snapshot");
    return {
        id: text(value, "id"),
        externalKey: text(value, "externalKey"),
        externalName: text(value, "externalName"),
        externalStatus: text(value, "externalStatus"),
        externalType: text(value, "externalType"),
        enabled: value.enabled,
        version: version(value.version),
    };
}
function templateSnapshot(value) {
    return {
        kind: "template",
        id: value.id,
        signatureId: value.signatureId,
        templateKey: value.templateKey,
        externalCode: value.externalCode,
        externalName: value.externalName,
        externalStatus: value.externalStatus,
        templateType: value.templateType,
        purpose: value.purpose,
        variables: value.variables.map(({ name, sensitive }) => ({ name, sensitive })),
        enabled: value.enabled,
        version: value.version,
    };
}
function templateFromSnapshot(value) {
    const variables = value.variables;
    if (value.kind !== "template" || typeof value.enabled !== "boolean" ||
        !["verification", "notification"].includes(String(value.templateType)) || !Array.isArray(variables)) {
        throw new TypeError("invalid template snapshot");
    }
    const projectedVariables = variables.map((variable) => {
        const item = record(variable);
        if (typeof item.sensitive !== "boolean")
            throw new TypeError("invalid template variable snapshot");
        return { name: text(item, "name"), sensitive: item.sensitive };
    });
    return {
        id: text(value, "id"),
        signatureId: text(value, "signatureId"),
        templateKey: text(value, "templateKey"),
        externalCode: text(value, "externalCode"),
        externalName: text(value, "externalName"),
        externalStatus: text(value, "externalStatus"),
        templateType: value.templateType,
        purpose: text(value, "purpose"),
        variables: projectedVariables,
        enabled: value.enabled,
        version: version(value.version),
    };
}
function validPage(input) {
    if (!Number.isSafeInteger(input.page) || input.page < 1 || !Number.isSafeInteger(input.pageSize) ||
        input.pageSize < 1 || input.pageSize > 100)
        throw new SmsKitError("CONFIG_INVALID", "invalid resource pagination");
}
function validWrite(input) {
    if (!Number.isSafeInteger(input.version) || input.version < 1 || input.idempotencyKey.trim().length === 0 ||
        input.idempotencyKey.length > 512)
        throw new SmsKitError("CONFIG_INVALID", "invalid resource update");
}
function validTemplateKey(templateKey) {
    try {
        validateTemplateKey(templateKey);
    }
    catch {
        throw new SmsKitError("CONFIG_INVALID", "invalid template key");
    }
}
function uuid(value) {
    return typeof value === "string" && UUID.test(value);
}
/** Owns all administrator reads/writes for the system-global signature/template catalog. */
export class ResourceAdminService {
    dependencies;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    async listSignatures(actor, input) {
        await this.dependencies.authorizer.assert(actor, "config.read");
        validPage(input);
        return this.dependencies.store.resources.listSignatures(input);
    }
    async listTemplates(actor, input) {
        await this.dependencies.authorizer.assert(actor, "config.read");
        validPage(input);
        return this.dependencies.store.resources.listTemplates(input);
    }
    async updateSignature(actor, input) {
        await this.dependencies.authorizer.assert(actor, "signature.manage");
        validWrite(input);
        if (!uuid(input.id) || typeof input.enabled !== "boolean")
            throw new SmsKitError("CONFIG_INVALID", "invalid signature update");
        const execution = await executeAdminOperation({
            store: this.dependencies.store,
            scope: SYSTEM_SCOPE,
            operation: "signature.update",
            idempotencyKey: input.idempotencyKey,
            request: { id: input.id, version: input.version, enabled: input.enabled },
            encode: signatureSnapshot,
            decode: signatureFromSnapshot,
            work: async (tx) => {
                const updated = await this.dependencies.store.resources.updateSignature({
                    id: input.id,
                    enabled: input.enabled,
                    expectedVersion: input.version,
                }, tx);
                await this.audit(actor, "signature.update", "signature", input.id, tx);
                return updated;
            },
        });
        if (!execution.replay)
            await this.emit("resource.signature.updated");
        return execution.value;
    }
    async importTemplate(actor, input) {
        await this.dependencies.authorizer.assert(actor, "template.manage");
        validWrite(input);
        validTemplateKey(input.templateKey);
        if (!uuid(input.candidateId) || [input.checksum, input.purpose, input.signatureExternalKey].some((value) => typeof value !== "string" || value.trim().length === 0)) {
            throw new SmsKitError("CONFIG_INVALID", "invalid template import");
        }
        const request = {
            version: input.version,
            candidateId: input.candidateId,
            checksum: input.checksum,
            templateKey: input.templateKey,
            purpose: input.purpose,
            signatureExternalKey: input.signatureExternalKey,
        };
        const execution = await executeAdminOperation({
            store: this.dependencies.store,
            scope: SYSTEM_SCOPE,
            operation: "template.import",
            idempotencyKey: input.idempotencyKey,
            request,
            encode: templateSnapshot,
            decode: templateFromSnapshot,
            work: async (tx) => {
                const imported = await this.dependencies.store.resources.importTemplate({
                    candidateId: input.candidateId,
                    checksum: input.checksum,
                    templateKey: input.templateKey,
                    purpose: input.purpose,
                    signatureExternalKey: input.signatureExternalKey,
                    expectedSignatureVersion: input.version,
                    now: this.dependencies.clock.now(),
                }, tx);
                await this.audit(actor, "template.import", "template", imported.id, tx);
                return imported;
            },
        });
        if (!execution.replay)
            await this.emit("resource.template.imported");
        return execution.value;
    }
    async updateTemplate(actor, input) {
        await this.dependencies.authorizer.assert(actor, "template.manage");
        validWrite(input);
        if (!uuid(input.id) || (input.templateKey === undefined && input.enabled === undefined && input.purpose === undefined)) {
            throw new SmsKitError("CONFIG_INVALID", "invalid template update");
        }
        if (input.templateKey !== undefined)
            validTemplateKey(input.templateKey);
        if (input.purpose !== undefined && input.purpose.trim().length === 0)
            throw new SmsKitError("CONFIG_INVALID", "invalid template purpose");
        const request = {
            id: input.id,
            version: input.version,
            ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        };
        const execution = await executeAdminOperation({
            store: this.dependencies.store,
            scope: SYSTEM_SCOPE,
            operation: "template.update",
            idempotencyKey: input.idempotencyKey,
            request,
            encode: templateSnapshot,
            decode: templateFromSnapshot,
            work: async (tx) => {
                const updated = await this.dependencies.store.resources.updateTemplate({
                    id: input.id,
                    expectedVersion: input.version,
                    ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
                    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
                    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                }, tx);
                await this.audit(actor, "template.update", "template", input.id, tx);
                return updated;
            },
        });
        if (!execution.replay)
            await this.emit("resource.template.updated");
        return execution.value;
    }
    async audit(actor, action, targetType, targetId, tx) {
        await this.dependencies.store.audits.append({
            id: this.dependencies.ids.next(), ...SYSTEM_SCOPE, actorId: actor.id,
            action, targetType, targetId, result: "succeeded", occurredAt: this.dependencies.clock.now(),
        }, tx);
    }
    async emit(name) {
        await this.dependencies.events.emit({ name, level: "info", metadata: { counts: [{ name: "resource", value: 1 }] } });
    }
}
