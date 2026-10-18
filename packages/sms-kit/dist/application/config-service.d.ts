import type { SmsProvider } from "../ports/provider.js";
import { type Clock, type EventSink, type IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor, SecretResolver } from "../ports/security.js";
import type { ProviderConfig, SmsStore, UpdateProviderConfigInput } from "../ports/store.js";
/**
 * Configuration authorization is actor-shape agnostic: ConfigService only
 * passes the actor to its injected Authorizer.  In particular this permits a
 * host's SYSTEM actor to retain its required null tenant boundary instead of
 * manufacturing a tenant identifier merely to configure a global provider.
 */
export type ConfigServiceDependencies<Actor extends Readonly<{
    id: string;
}> = AuthorizationActor> = Readonly<{
    store: SmsStore;
    provider: SmsProvider;
    secretResolver: SecretResolver;
    authorizer: Authorizer<Actor>;
    clock: Clock;
    ids: Pick<IdGenerator, "next">;
    events: EventSink;
    /** Bounds resolver/provider I/O while the versioned config fence is held. */
    connectionTestTimeoutMs?: number;
}>;
export type PatchProviderConfigInput = Readonly<{
    provider: "aliyun";
    region: string;
    endpoint?: string;
    accessKeyIdRef: string;
    accessKeySecretRef: string;
    receiptCallbackTokenRef?: string;
    enabled?: boolean;
    expectedVersion: number;
    idempotencyKey: string;
}>;
/** Versioned connection tests are replayed without repeating provider I/O. */
export type TestConnectionInput = Readonly<{
    expectedVersion: number;
    idempotencyKey: string;
}>;
/** Manages the singleton provider configuration; it never returns resolved secret values. */
export declare class ConfigService<Actor extends Readonly<{
    id: string;
}> = AuthorizationActor> {
    private readonly dependencies;
    private readonly connectionTestTimeoutMs;
    constructor(dependencies: ConfigServiceDependencies<Actor>);
    get(actor: Actor): Promise<ProviderConfig>;
    save(actor: Actor, input: UpdateProviderConfigInput): Promise<ProviderConfig>;
    /** Applies the public PATCH contract with durable, tenant-fenced replay semantics. */
    patch(actor: Actor, input: PatchProviderConfigInput): Promise<ProviderConfig>;
    /**
     * Tests are versioned when invoked by the public admin API. The legacy
     * no-metadata form remains for existing non-HTTP compositions, but callers
     * cannot accidentally get its weaker retry behavior through the Next route.
     */
    testConnection(actor: Actor, input?: TestConnectionInput): Promise<ProviderConfig>;
    private testConnectionVersioned;
    private testConnectionLegacy;
    /** Runs only resolvers/provider I/O; it never exposes or stores resolved credentials. */
    private runConnectionTest;
    private audit;
    private emit;
}
