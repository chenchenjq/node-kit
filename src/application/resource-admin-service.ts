import { SmsKitError } from "../core/errors.js";
import { validateTemplateKey } from "../core/template.js";
import type { TemplateId, TenantId } from "../core/types.js";
import type { Clock, EventSink, IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import type { Signature, SmsStore, Template } from "../ports/store.js";
import { executeAdminOperation } from "./admin-operation.js";

const SYSTEM_TENANT_ID = "__system__" as TenantId;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ResourceAdminServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  store: SmsStore;
  authorizer: Authorizer<Actor>;
  clock: Clock;
  ids: Pick<IdGenerator, "next">;
  events: EventSink;
}>;

export type ResourceAdminUpdateSignatureInput = Readonly<{
  id: string;
  version: number;
  idempotencyKey: string;
  enabled: boolean;
}>;
export type ResourceAdminImportTemplateInput = Readonly<{
  version: number;
  idempotencyKey: string;
  candidateId: string;
  checksum: string;
  templateKey: string;
  purpose: string;
  signatureExternalKey: string;
}>;
export type ResourceAdminUpdateTemplateInput = Readonly<{
  id: string;
  version: number;
  idempotencyKey: string;
  templateKey?: string;
  enabled?: boolean;
  purpose?: string;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("invalid resource snapshot");
  return value as Readonly<Record<string, unknown>>;
}

function text(value: Readonly<Record<string, unknown>>, name: string): string {
  const result = value[name];
  if (typeof result !== "string" || result.length === 0) throw new TypeError(`invalid ${name}`);
  return result;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError("invalid version");
  return value as number;
}

function signatureSnapshot(value: Signature): Readonly<Record<string, unknown>> {
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

function signatureFromSnapshot(value: Readonly<Record<string, unknown>>): Signature {
  if (value.kind !== "signature" || typeof value.enabled !== "boolean") throw new TypeError("invalid signature snapshot");
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

function templateSnapshot(value: Template): Readonly<Record<string, unknown>> {
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

function templateFromSnapshot(value: Readonly<Record<string, unknown>>): Template {
  const variables = value.variables;
  if (value.kind !== "template" || typeof value.enabled !== "boolean" ||
      !["verification", "notification"].includes(String(value.templateType)) || !Array.isArray(variables)) {
    throw new TypeError("invalid template snapshot");
  }
  const projectedVariables = variables.map((variable) => {
    const item = record(variable);
    if (typeof item.sensitive !== "boolean") throw new TypeError("invalid template variable snapshot");
    return { name: text(item, "name"), sensitive: item.sensitive };
  });
  return {
    id: text(value, "id") as TemplateId,
    signatureId: text(value, "signatureId"),
    templateKey: text(value, "templateKey"),
    externalCode: text(value, "externalCode"),
    externalName: text(value, "externalName"),
    externalStatus: text(value, "externalStatus"),
    templateType: value.templateType as Template["templateType"],
    purpose: text(value, "purpose"),
    variables: projectedVariables,
    enabled: value.enabled,
    version: version(value.version),
  };
}

function validPage(input: Readonly<{ page: number; pageSize: number }>): void {
  if (!Number.isSafeInteger(input.page) || input.page < 1 || !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 || input.pageSize > 100) throw new SmsKitError("CONFIG_INVALID", "invalid resource pagination");
}

function validWrite(input: Readonly<{ version: number; idempotencyKey: string }>): void {
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.idempotencyKey.trim().length === 0 ||
      input.idempotencyKey.length > 512) throw new SmsKitError("CONFIG_INVALID", "invalid resource update");
}

function validTemplateKey(templateKey: string): void {
  try {
    validateTemplateKey(templateKey);
  } catch {
    throw new SmsKitError("CONFIG_INVALID", "invalid template key");
  }
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Owns all administrator reads/writes for the system-global signature/template catalog. */
export class ResourceAdminService<Actor extends AuthorizationActor = AuthorizationActor> {
  constructor(private readonly dependencies: ResourceAdminServiceDependencies<Actor>) {}

  async listSignatures(actor: Actor, input: Readonly<{ page: number; pageSize: number }>) {
    await this.dependencies.authorizer.assert(actor, "config.read");
    validPage(input);
    return this.dependencies.store.resources.listSignatures(input);
  }

  async listTemplates(actor: Actor, input: Readonly<{ page: number; pageSize: number }>) {
    await this.dependencies.authorizer.assert(actor, "config.read");
    validPage(input);
    return this.dependencies.store.resources.listTemplates(input);
  }

  async updateSignature(actor: Actor, input: ResourceAdminUpdateSignatureInput): Promise<Signature> {
    await this.dependencies.authorizer.assert(actor, "signature.manage");
    validWrite(input);
    if (!uuid(input.id) || typeof input.enabled !== "boolean") throw new SmsKitError("CONFIG_INVALID", "invalid signature update");
    const execution = await executeAdminOperation({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
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
    if (!execution.replay) await this.emit("resource.signature.updated");
    return execution.value;
  }

  async importTemplate(actor: Actor, input: ResourceAdminImportTemplateInput): Promise<Template> {
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
      tenantId: actor.tenantId,
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
    if (!execution.replay) await this.emit("resource.template.imported");
    return execution.value;
  }

  async updateTemplate(actor: Actor, input: ResourceAdminUpdateTemplateInput): Promise<Template> {
    await this.dependencies.authorizer.assert(actor, "template.manage");
    validWrite(input);
    if (!uuid(input.id) || (input.templateKey === undefined && input.enabled === undefined && input.purpose === undefined)) {
      throw new SmsKitError("CONFIG_INVALID", "invalid template update");
    }
    if (input.templateKey !== undefined) validTemplateKey(input.templateKey);
    if (input.purpose !== undefined && input.purpose.trim().length === 0) throw new SmsKitError("CONFIG_INVALID", "invalid template purpose");
    const request = {
      id: input.id,
      version: input.version,
      ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    };
    const execution = await executeAdminOperation({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "template.update",
      idempotencyKey: input.idempotencyKey,
      request,
      encode: templateSnapshot,
      decode: templateFromSnapshot,
      work: async (tx) => {
        const updated = await this.dependencies.store.resources.updateTemplate({
          id: input.id as TemplateId,
          expectedVersion: input.version,
          ...(input.templateKey === undefined ? {} : { templateKey: input.templateKey }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        }, tx);
        await this.audit(actor, "template.update", "template", input.id, tx);
        return updated;
      },
    });
    if (!execution.replay) await this.emit("resource.template.updated");
    return execution.value;
  }

  private async audit(actor: Actor, action: string, targetType: string, targetId: string, tx: Parameters<SmsStore["audits"]["append"]>[1]) {
    await this.dependencies.store.audits.append({
      id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
      action, targetType, targetId, result: "succeeded", occurredAt: this.dependencies.clock.now(),
    }, tx);
  }

  private async emit(name: string): Promise<void> {
    await this.dependencies.events.emit({ name, level: "info", metadata: { counts: [{ name: "resource", value: 1 }] } });
  }
}
