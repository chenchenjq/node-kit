import { SmsKitError } from "../core/errors.js";
import type { ProviderAuthInput, ProviderPage, ProviderSignature, ProviderTemplate, SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink, IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import type { TenantId } from "../core/types.js";
import {
  createResourceSyncCandidate,
  hasTemplateResourceSelection,
  type ConfiguredProviderConfig,
  type ResourceSyncCandidate,
  type ResourceSyncPreview,
  type SmsStore,
  type SmsTransaction,
  type TemplateResourceSelection,
} from "../ports/store.js";
import { canonicalChecksum } from "./checksum.js";
import { executeAdminOperation, findAdminOperationReplay } from "./admin-operation.js";

export type ResourceSyncTemplateSelection = TemplateResourceSelection & Readonly<{
  externalKey: string;
}>;

export type ResourceSyncPreviewInput = Readonly<{
  /** @deprecated Template mappings are rejected; use ResourceAdminService.importTemplate. */
  templates?: readonly ResourceSyncTemplateSelection[];
  pageSize?: number;
  /** Supplying both write fields activates durable admin replay and a config fence. */
  expectedVersion?: number;
  idempotencyKey?: string;
}>;

export type ResourceSyncCommitInput = Readonly<{
  syncId: string;
  candidates: readonly Readonly<{ id: string; checksum: string }>[];
  /** Supplying both write fields activates durable admin replay and a config fence. */
  expectedVersion?: number;
  idempotencyKey?: string;
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
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

function candidateChecksum(candidate: unknown): string {
  return canonicalChecksum(candidate);
}

type AdminMetadata = Readonly<{ expectedVersion: number; idempotencyKey: string }>;

function adminMetadata(input: Readonly<{ expectedVersion?: number; idempotencyKey?: string }>): AdminMetadata | undefined {
  const hasVersion = input.expectedVersion !== undefined;
  const hasKey = input.idempotencyKey !== undefined;
  if (hasVersion !== hasKey) throw new SmsKitError("CONFIG_INVALID", "resource sync version and idempotency key must be supplied together");
  if (!hasVersion) return undefined;
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion! < 0 ||
      typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 512) {
    throw new SmsKitError("CONFIG_INVALID", "invalid resource sync write metadata");
  }
  return { expectedVersion: input.expectedVersion!, idempotencyKey: input.idempotencyKey };
}

function requireConfigVersion(config: Awaited<ReturnType<SmsStore["config"]["get"]>>, expectedVersion: number): void {
  if (config.version !== expectedVersion) {
    throw new SmsKitError("CONCURRENT_MODIFICATION", "provider configuration changed concurrently");
  }
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("invalid resource sync snapshot");
  return value as Readonly<Record<string, unknown>>;
}

function snapshotText(value: Readonly<Record<string, unknown>>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) throw new TypeError(`invalid resource sync ${key}`);
  return result;
}

function syncSnapshot(value: ResourceSyncPreview): Readonly<Record<string, unknown>> {
  return {
    kind: "resource-sync-preview",
    id: value.id,
    status: value.status,
    expiresAt: value.expiresAt.toISOString(),
    candidates: value.candidates.map((candidate) => candidate.resourceType === "signature" ? {
      id: candidate.id,
      externalKey: candidate.externalKey,
      changeType: candidate.changeType,
      checksum: candidate.checksum,
      resourceType: "signature",
      snapshot: {
        kind: "signature",
        externalName: candidate.snapshot.externalName,
        externalStatus: candidate.snapshot.externalStatus,
        externalType: candidate.snapshot.externalType,
      },
    } : {
      id: candidate.id,
      externalKey: candidate.externalKey,
      changeType: candidate.changeType,
      checksum: candidate.checksum,
      resourceType: "template",
      ...(hasTemplateResourceSelection(candidate) ? {
        signatureExternalKey: candidate.signatureExternalKey,
        templateKey: candidate.templateKey,
        purpose: candidate.purpose,
      } : {}),
      snapshot: {
        kind: "template",
        externalCode: candidate.snapshot.externalCode,
        externalName: candidate.snapshot.externalName,
        externalStatus: candidate.snapshot.externalStatus,
        templateType: candidate.snapshot.templateType,
        variableNames: [...candidate.snapshot.variableNames],
      },
    }),
  };
}

function syncFromSnapshot(value: Readonly<Record<string, unknown>>): ResourceSyncPreview {
  if (value.kind !== "resource-sync-preview" || !Array.isArray(value.candidates)) throw new TypeError("invalid resource sync snapshot");
  const status = snapshotText(value, "status");
  if (!(["running", "succeeded", "partial", "failed"] as const).includes(status as ResourceSyncPreview["status"])) {
    throw new TypeError("invalid resource sync status");
  }
  const expiresAt = new Date(snapshotText(value, "expiresAt"));
  if (Number.isNaN(expiresAt.getTime())) throw new TypeError("invalid resource sync expiry");
  return {
    id: snapshotText(value, "id"),
    status: status as ResourceSyncPreview["status"],
    expiresAt,
    candidates: value.candidates.map((candidate) => createResourceSyncCandidate(snapshotRecord(candidate))),
  };
}

/** Discovers complete provider snapshots, then commits only persisted, checksummed selections. */
export class ResourceSyncService<Actor extends AuthorizationActor = AuthorizationActor> {
  constructor(private readonly dependencies: ResourceSyncServiceDependencies<Actor>) {}

  async preview(actor: Actor, input: ResourceSyncPreviewInput = {}): Promise<ResourceSyncPreview> {
    await this.dependencies.authorizer.assert(actor, "resource.sync");
    if (input.templates !== undefined) {
      throw new SmsKitError("CONFIG_INVALID", "template mappings require an explicit import");
    }
    const pageSize = validPageSize(input.pageSize);
    const metadata = adminMetadata(input);
    const request = metadata === undefined ? undefined : {
      expectedVersion: metadata.expectedVersion,
      pageSize,
    };
    if (metadata !== undefined) {
      const replay = await findAdminOperationReplay({
        store: this.dependencies.store,
        tenantId: actor.tenantId,
        operation: "resource.sync.preview",
        idempotencyKey: metadata.idempotencyKey,
        request,
        decode: syncFromSnapshot,
      });
      if (replay !== undefined) return replay;
    }
    // Fence against the raw record before checking readiness.  A concurrent
    // config PATCH may make the record unconfigured or disabled; that must be
    // reported as the caller's stale optimistic version, not as a misleading
    // readiness error.
    const currentConfig = await this.dependencies.store.config.get();
    if (metadata !== undefined) requireConfigVersion(currentConfig, metadata.expectedVersion);
    const config = providerConfig(currentConfig);
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
    const localSignaturesById = new Map(localSignatures.map((signature) => [signature.id, signature]));
    const discoveredSignatureKeys = new Set(signatures.map((signature) => signature.externalKey));
    const refreshesByExternalKey = new Map<string, ResourceSyncTemplateSelection>();
    // Only previously imported resources carry stable local mappings in a
    // resource.sync snapshot. First imports always remain mapping-free.
    for (const remote of templates) {
      const local = localTemplatesByCode.get(remote.externalCode);
      if (local === undefined) continue;
      if (changedTemplate(remote, { ...local, variableNames: local.variables.map(({ name }) => name) }) === "unchanged") continue;
      const signature = localSignaturesById.get(local.signatureId);
      if (signature === undefined) throw new SmsKitError("STORAGE_FAILURE", "template has no local signature", true);
      refreshesByExternalKey.set(remote.externalKey, { externalKey: remote.externalKey, signatureExternalKey: signature.externalKey, templateKey: local.templateKey, purpose: local.purpose });
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
    for (const [externalKey, selection] of refreshesByExternalKey) {
      const template = templates.find((item) => item.externalKey === externalKey);
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
    // Every provider template is discoverable before a local stable key,
    // purpose, or signature mapping exists. Those administrator-owned fields
    // are deliberately absent until the explicit template-import operation.
    for (const template of templates) {
      if (localTemplatesByCode.has(template.externalCode)) continue;
      const base = {
        id: this.dependencies.ids.next(), externalKey: template.externalKey,
        changeType: "new" as const, resourceType: "template" as const,
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
    const persist = async (tx: SmsTransaction) => {
      if (metadata !== undefined) {
        const lockedConfig = await this.dependencies.store.config.get(tx);
        requireConfigVersion(lockedConfig, metadata.expectedVersion);
        providerConfig(lockedConfig);
      }
      const created = await this.dependencies.store.resources.createSyncPreview({
        id: this.dependencies.ids.next(), actorId: actor.id, expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS), resources,
      }, tx);
      await this.dependencies.store.audits.append({
        id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
        action: "resource.sync.preview", targetType: "resource_sync", targetId: created.id,
        result: "succeeded", metadata: { counts: [{ name: "resource", value: resources.length }] }, occurredAt: this.dependencies.clock.now(),
      }, tx);
      return created;
    };
    const execution = metadata === undefined
      ? { value: await this.dependencies.store.transaction(persist), replay: false }
      : await executeAdminOperation({
        store: this.dependencies.store,
        tenantId: actor.tenantId,
        operation: "resource.sync.preview",
        idempotencyKey: metadata.idempotencyKey,
        request,
        encode: syncSnapshot,
        decode: syncFromSnapshot,
        work: persist,
      });
    if (!execution.replay) {
      await this.dependencies.events.emit({ name: "resource.sync.previewed", level: "info", metadata: { counts: [{ name: "resource", value: resources.length }] } });
    }
    return execution.value;
  }

  async commit(actor: Actor, input: ResourceSyncCommitInput): Promise<ResourceSyncPreview> {
    await this.dependencies.authorizer.assert(actor, "resource.sync");
    if (!uuid(input.syncId) || input.candidates.some((candidate) => !uuid(candidate.id) || typeof candidate.checksum !== "string" || candidate.checksum.length === 0)) {
      throw new SmsKitError("CONFIG_INVALID", "invalid resource sync commit");
    }
    const metadata = adminMetadata(input);
    const request = metadata === undefined ? undefined : {
      expectedVersion: metadata.expectedVersion,
      syncId: input.syncId,
      candidates: input.candidates.map((candidate) => ({ id: candidate.id, checksum: candidate.checksum })),
    };
    if (metadata !== undefined) {
      const replay = await findAdminOperationReplay({
        store: this.dependencies.store,
        tenantId: actor.tenantId,
        operation: "resource.sync.commit",
        idempotencyKey: metadata.idempotencyKey,
        request,
        decode: syncFromSnapshot,
      });
      if (replay !== undefined) return replay;
    }
    const persist = async (tx: SmsTransaction) => {
      if (metadata !== undefined) {
        const lockedConfig = await this.dependencies.store.config.get(tx);
        requireConfigVersion(lockedConfig, metadata.expectedVersion);
        providerConfig(lockedConfig);
      }
      const result = await this.dependencies.store.resources.commitSync({
        syncId: input.syncId,
        candidates: input.candidates,
        now: this.dependencies.clock.now(),
      }, tx);
      await this.dependencies.store.audits.append({
        id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
        action: "resource.sync.commit", targetType: "resource_sync", targetId: input.syncId,
        result: "succeeded", metadata: { counts: [{ name: "resource", value: result.candidates.length }] }, occurredAt: this.dependencies.clock.now(),
      }, tx);
      return result;
    };
    const execution = metadata === undefined
      ? { value: await this.dependencies.store.transaction(persist), replay: false }
      : await executeAdminOperation({
        store: this.dependencies.store,
        tenantId: actor.tenantId,
        operation: "resource.sync.commit",
        idempotencyKey: metadata.idempotencyKey,
        request,
        encode: syncSnapshot,
        decode: syncFromSnapshot,
        work: persist,
      });
    if (!execution.replay) {
      await this.dependencies.events.emit({ name: "resource.sync.committed", level: "info", metadata: { counts: [{ name: "resource", value: execution.value.candidates.length }] } });
    }
    return execution.value;
  }
}
