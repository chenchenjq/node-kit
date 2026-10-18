import type { SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink, IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import { type ResourceSyncPreview, type SmsStore, type TemplateResourceSelection } from "../ports/store.js";
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
    candidates: readonly Readonly<{
        id: string;
        checksum: string;
    }>[];
    /** Supplying both write fields activates durable admin replay and a config fence. */
    expectedVersion?: number;
    idempotencyKey?: string;
}>;
export type ResourceSyncServiceDependencies<Actor extends Readonly<{
    id: string;
}> = AuthorizationActor> = Readonly<{
    store: SmsStore;
    provider: SmsProvider;
    authorizer: Authorizer<Actor>;
    clock: Clock;
    ids: Pick<IdGenerator, "next">;
    events: EventSink;
}>;
/** Discovers complete provider snapshots, then commits only persisted, checksummed selections. */
export declare class ResourceSyncService<Actor extends Readonly<{
    id: string;
}> = AuthorizationActor> {
    private readonly dependencies;
    constructor(dependencies: ResourceSyncServiceDependencies<Actor>);
    preview(actor: Actor, input?: ResourceSyncPreviewInput): Promise<ResourceSyncPreview>;
    commit(actor: Actor, input: ResourceSyncCommitInput): Promise<ResourceSyncPreview>;
}
