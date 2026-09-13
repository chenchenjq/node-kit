import { SmsKitError } from "../core/errors.js";
import { isUsableSignature } from "../core/resource-usability.js";
import { validateTemplateKey } from "../core/template.js";
import type { ProviderAuthInput, ProviderPage, ProviderSignature, ProviderTemplate, SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink, IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import type { TenantId } from "../core/types.js";
import {
  createResourceSyncCandidate,
  type ConfiguredProviderConfig,
  type ResourceSyncCandidate,
  type ResourceSyncPreview,
  type SmsStore,
  type TemplateResourceSelection,
} from "../ports/store.js";
import { canonicalChecksum } from "./checksum.js";

export type ResourceSyncTemplateSelection = TemplateResourceSelection & Readonly<{
  externalKey: string;
}>;

export type ResourceSyncPreviewInput = Readonly<{
  /** Templates are opt-in because their stable local name and purpose are admin choices. */
  templates?: readonly ResourceSyncTemplateSelection[];
  pageSize?: number;
}>;

export type ResourceSyncCommitInput = Readonly<{
  syncId: string;
  candidates: readonly Readonly<{ id: string; checksum: string }>[];
}>;

export type ResourceSyncServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  store: SmsStore;
  provider: SmsProvider;
  authorizer: Authorizer<Actor>;
  clock: Clock;
  ids: Pick<IdGenerator, "next">;
  events: EventSink;
}>;

const PREVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_PAGE_SIZE = 50;
const SYSTEM_TENANT_ID = "__system__" as TenantId;

function providerConfig(config: Awaited<ReturnType<SmsStore["config"]["get"]>>): ConfiguredProviderConfig {
  if (config.status === "unconfigured" || config.status !== "ready" || !config.enabled) {
    throw new SmsKitError("CONFIG_INVALID", "provider configuration is not ready");
  }
  return config;
}

function providerAuth(config: ConfiguredProviderConfig): ProviderAuthInput {
  return {
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    // The provider resolves these references only at call time and never stores them.
    accessKeyId: config.accessKeyIdRef,
    accessKeySecret: config.accessKeySecretRef,
  };
}

function validPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new SmsKitError("CONFIG_INVALID", "invalid resource page size");
  }
  return value;
}

async function collectAllProviderPages<T extends { externalKey: string }>(
  pageSize: number,
  fetch: (input: ProviderAuthInput & { pageSize: number; cursor?: string }) => Promise<ProviderPage<T>>,
  auth: ProviderAuthInput,
): Promise<readonly T[]> {
  const result: T[] = [];
  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < 10_000; pages += 1) {
    const page = await fetch({ ...auth, pageSize, ...(cursor === undefined ? {} : { cursor }) });
    if (!Array.isArray(page.items)) throw new SmsKitError("PROVIDER_UNAVAILABLE", "provider resource listing is unavailable", true);
    for (const item of page.items) {
      if (typeof item.externalKey !== "string" || item.externalKey.length === 0 || keys.has(item.externalKey)) {
        throw new SmsKitError("PROVIDER_UNAVAILABLE", "provider resource listing is unavailable", true);
      }
      keys.add(item.externalKey);
      result.push(item);
    }
    if (page.nextCursor === undefined) return result.sort((left, right) => left.externalKey.localeCompare(right.externalKey));
    if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0 || cursors.has(page.nextCursor)) {
      throw new SmsKitError("PROVIDER_UNAVAILABLE", "provider resource listing is unavailable", true);
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new SmsKitError("PROVIDER_UNAVAILABLE", "provider resource listing is unavailable", true);
}

async function listAllLocal<T>(
  fetch: (input: { page: number; pageSize: number }) => Promise<{ items: readonly T[]; total: number }>,
  pageSize: number,
): Promise<readonly T[]> {
  const result: T[] = [];
  for (let page = 1; ; page += 1) {
    const value = await fetch({ page, pageSize });
    if (!Array.isArray(value.items) || !Number.isSafeInteger(value.total) || value.total < result.length) {
      throw new SmsKitError("STORAGE_FAILURE", "resource listing is invalid", true);
    }
    result.push(...value.items);
    if (result.length >= value.total) return result;
    if (value.items.length === 0 || page >= 10_000) throw new SmsKitError("STORAGE_FAILURE", "resource listing is incomplete", true);
  }
}

function changedSignature(remote: ProviderSignature, local: { externalName: string; externalStatus: string; externalType: string } | undefined): ResourceSyncCandidate["changeType"] {
  if (local === undefined) return "new";
  return local.externalName === remote.externalName && local.externalStatus === remote.externalStatus && local.externalType === remote.externalType
    ? "unchanged" : "changed";
}

function changedTemplate(remote: ProviderTemplate, local: { externalName: string; externalStatus: string; templateType: string; variableNames: readonly string[] } | undefined): ResourceSyncCandidate["changeType"] {
  if (local === undefined) return "new";
  return local.externalName === remote.externalName && local.externalStatus === remote.externalStatus && local.templateType === remote.templateType &&
    local.variableNames.length === remote.variableNames.length && local.variableNames.every((name, index) => name === remote.variableNames[index])
    ? "unchanged" : "changed";
}

function assertSelection(selection: ResourceSyncTemplateSelection): void {
  try { validateTemplateKey(selection.templateKey); } catch { throw new SmsKitError("CONFIG_INVALID", "invalid template selection"); }
  if (selection.externalKey.trim().length === 0 || selection.signatureExternalKey.trim().length === 0 || selection.purpose.trim().length === 0) {
    throw new SmsKitError("CONFIG_INVALID", "invalid template selection");
  }
}

function candidateChecksum(candidate: unknown): string {
  return canonicalChecksum(candidate);
}

/** Discovers complete provider snapshots, then commits only persisted, checksummed selections. */
export class ResourceSyncService<Actor extends AuthorizationActor = AuthorizationActor> {
  constructor(private readonly dependencies: ResourceSyncServiceDependencies<Actor>) {}

  async preview(actor: Actor, input: ResourceSyncPreviewInput = {}): Promise<ResourceSyncPreview> {
    await this.dependencies.authorizer.assert(actor, "resource.sync");
    const pageSize = validPageSize(input.pageSize);
    const config = providerConfig(await this.dependencies.store.config.get());
    const auth = providerAuth(config);
    // All four reads complete before persistence. A rejected provider page therefore
    // cannot leave a partial snapshot capable of changing existing resources.
    const [signatures, templates, localSignatures, localTemplates] = await Promise.all([
      collectAllProviderPages(pageSize, (page) => this.dependencies.provider.listSignatures(page), auth),
      collectAllProviderPages(pageSize, (page) => this.dependencies.provider.listTemplates(page), auth),
      listAllLocal((page) => this.dependencies.store.resources.listSignatures(page), pageSize),
      listAllLocal((page) => this.dependencies.store.resources.listTemplates(page), pageSize),
    ]);
    const localSignaturesByKey = new Map(localSignatures.map((signature) => [signature.externalKey, signature]));
    const localTemplatesByCode = new Map(localTemplates.map((template) => [template.externalCode, template]));
    const localTemplatesByKey = new Map(localTemplates.map((template) => [template.templateKey, template]));
    const localSignaturesById = new Map(localSignatures.map((signature) => [signature.id, signature]));
    const discoveredSignatureKeys = new Set(signatures.map((signature) => signature.externalKey));
    const selectableSignatureKeys = new Set(signatures.filter((signature) => isUsableSignature({
      externalStatus: signature.externalStatus,
      enabled: localSignaturesByKey.get(signature.externalKey)?.enabled ?? true,
    })).map((signature) => signature.externalKey));
    const templateByExternalKey = new Map(templates.map((template) => [template.externalKey, template]));
    const selections = input.templates ?? [];
    const selectionsByExternalKey = new Map<string, ResourceSyncTemplateSelection>();
    for (const selection of selections) {
      assertSelection(selection);
      const remoteTemplate = templateByExternalKey.get(selection.externalKey);
      const priorByKey = localTemplatesByKey.get(selection.templateKey);
      const priorByCode = remoteTemplate === undefined ? undefined : localTemplatesByCode.get(remoteTemplate.externalCode);
      if (remoteTemplate === undefined || selectionsByExternalKey.has(selection.externalKey) || !selectableSignatureKeys.has(selection.signatureExternalKey) ||
          (priorByKey !== undefined && priorByKey.externalCode !== remoteTemplate.externalCode) ||
          (priorByCode !== undefined && priorByCode.templateKey !== selection.templateKey)) {
        throw new SmsKitError("CONFIG_INVALID", "invalid template selection");
      }
      selectionsByExternalKey.set(selection.externalKey, selection);
    }
    // Imported resources remain observable even when administrators select no new imports.
    for (const remote of templates) {
      const local = localTemplatesByCode.get(remote.externalCode);
      if (local === undefined || selectionsByExternalKey.has(remote.externalKey)) continue;
      if (changedTemplate(remote, { ...local, variableNames: local.variables.map(({ name }) => name) }) === "unchanged") continue;
      const signature = localSignaturesById.get(local.signatureId);
      if (signature === undefined) throw new SmsKitError("STORAGE_FAILURE", "template has no local signature", true);
      selectionsByExternalKey.set(remote.externalKey, { externalKey: remote.externalKey, signatureExternalKey: signature.externalKey, templateKey: local.templateKey, purpose: local.purpose });
    }

    const resources: ResourceSyncCandidate[] = [];
    for (const signature of signatures) {
      const base = {
        id: this.dependencies.ids.next(), externalKey: signature.externalKey,
        changeType: changedSignature(signature, localSignaturesByKey.get(signature.externalKey)), resourceType: "signature" as const,
        snapshot: { kind: "signature" as const, externalName: signature.externalName, externalStatus: signature.externalStatus, externalType: signature.externalType },
      };
      resources.push(createResourceSyncCandidate({ ...base, checksum: candidateChecksum(base) }));
    }
    for (const signature of localSignatures) {
      if (discoveredSignatureKeys.has(signature.externalKey)) continue;
      const base = {
        id: this.dependencies.ids.next(), externalKey: signature.externalKey, changeType: "unavailable" as const, resourceType: "signature" as const,
        snapshot: { kind: "signature" as const, externalName: signature.externalName, externalStatus: "unavailable", externalType: signature.externalType },
      };
      resources.push(createResourceSyncCandidate({ ...base, checksum: candidateChecksum(base) }));
    }
    for (const [externalKey, selection] of selectionsByExternalKey) {
      const template = templateByExternalKey.get(externalKey);
      if (template === undefined) throw new SmsKitError("CONFIG_INVALID", "selected template is not in the provider snapshot");
      const base = {
        id: this.dependencies.ids.next(), externalKey: template.externalKey,
        changeType: changedTemplate(template, localTemplatesByCode.get(template.externalCode) === undefined ? undefined : {
          externalName: localTemplatesByCode.get(template.externalCode)!.externalName,
          externalStatus: localTemplatesByCode.get(template.externalCode)!.externalStatus,
          templateType: localTemplatesByCode.get(template.externalCode)!.templateType,
          variableNames: localTemplatesByCode.get(template.externalCode)!.variables.map((variable) => variable.name),
        }), resourceType: "template" as const,
        signatureExternalKey: selection.signatureExternalKey, templateKey: selection.templateKey, purpose: selection.purpose,
        snapshot: {
          kind: "template" as const, externalCode: template.externalCode, externalName: template.externalName,
          externalStatus: template.externalStatus, templateType: template.templateType, variableNames: [...template.variableNames],
        },
      };
      resources.push(createResourceSyncCandidate({ ...base, checksum: candidateChecksum(base) }));
    }
    const discoveredTemplateCodes = new Set(templates.map((template) => template.externalCode));
    for (const template of localTemplates) {
      if (discoveredTemplateCodes.has(template.externalCode)) continue;
      const signature = localSignaturesById.get(template.signatureId);
      if (signature === undefined) throw new SmsKitError("STORAGE_FAILURE", "template has no local signature", true);
      const base = {
        id: this.dependencies.ids.next(), externalKey: `aliyun:template:${template.externalCode}`,
        changeType: "unavailable" as const, resourceType: "template" as const,
        signatureExternalKey: signature.externalKey, templateKey: template.templateKey, purpose: template.purpose,
        snapshot: {
          kind: "template" as const, externalCode: template.externalCode, externalName: template.externalName,
          externalStatus: "unavailable", templateType: template.templateType, variableNames: template.variables.map((variable) => variable.name),
        },
      };
      resources.push(createResourceSyncCandidate({ ...base, checksum: candidateChecksum(base) }));
    }
    const now = this.dependencies.clock.now();
    const preview = await this.dependencies.store.transaction(async (tx) => {
      const created = await this.dependencies.store.resources.createSyncPreview({
        id: this.dependencies.ids.next(), actorId: actor.id, expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS), resources,
      }, tx);
      await this.dependencies.store.audits.append({
        id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
        action: "resource.sync.preview", targetType: "resource_sync", targetId: created.id,
        result: "succeeded", metadata: { counts: [{ name: "resource", value: resources.length }] }, occurredAt: this.dependencies.clock.now(),
      }, tx);
      return created;
    });
    await this.dependencies.events.emit({ name: "resource.sync.previewed", level: "info", metadata: { counts: [{ name: "resource", value: resources.length }] } });
    return preview;
  }

  async commit(actor: Actor, input: ResourceSyncCommitInput): Promise<ResourceSyncPreview> {
    await this.dependencies.authorizer.assert(actor, "resource.sync");
    if (input.syncId.length === 0 || input.candidates.some((candidate) => candidate.id.length === 0 || candidate.checksum.length === 0)) {
      throw new SmsKitError("CONFIG_INVALID", "invalid resource sync commit");
    }
    const committed = await this.dependencies.store.transaction(async (tx) => {
      const result = await this.dependencies.store.resources.commitSync({ ...input, now: this.dependencies.clock.now() }, tx);
      await this.dependencies.store.audits.append({
        id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
        action: "resource.sync.commit", targetType: "resource_sync", targetId: input.syncId,
        result: "succeeded", metadata: { counts: [{ name: "resource", value: result.candidates.length }] }, occurredAt: this.dependencies.clock.now(),
      }, tx);
      return result;
    });
    await this.dependencies.events.emit({ name: "resource.sync.committed", level: "info", metadata: { counts: [{ name: "resource", value: committed.candidates.length }] } });
    return committed;
  }
}
