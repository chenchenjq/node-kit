import { SmsKitError } from "../core/errors.js";
import { isProviderEndpointOrigin } from "../core/provider-endpoint.js";
import type { SmsProvider } from "../ports/provider.js";
import { withProviderTimeout } from "../ports/provider-timeout.js";
import { projectSafeEventMetadata, type Clock, type EventSink, type IdGenerator, type SafeEventMetadata } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor, SecretResolver } from "../ports/security.js";
import type { ConfiguredProviderConfig, ProviderConfig, SmsStore, UpdateProviderConfigInput } from "../ports/store.js";
import type { TenantId } from "../core/types.js";
import { executeAdminOperation, findAdminOperationReplay } from "./admin-operation.js";

const SYSTEM_TENANT_ID = "__system__" as TenantId;
const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 10_000;

export type ConfigServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
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

type ConnectionTestOutcome = Readonly<{
  config: ConfiguredProviderConfig;
  outcome: "succeeded" | "failed";
  errorCode?: "SECRET_UNRESOLVABLE" | "PROVIDER_UNAVAILABLE";
}>;

function configured(config: ProviderConfig): asserts config is ConfiguredProviderConfig {
  if (config.status === "unconfigured") {
    throw new SmsKitError("CONFIG_INVALID", "provider configuration is incomplete");
  }
}

function assertConfigInput(input: UpdateProviderConfigInput): void {
  if (input.provider !== "aliyun" || input.region.trim().length === 0 ||
      input.accessKeyIdRef.trim().length === 0 || input.accessKeySecretRef.trim().length === 0 ||
      input.receiptCallbackTokenRef.trim().length === 0 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new SmsKitError("CONFIG_INVALID", "invalid provider configuration");
  }
  if (input.endpoint !== undefined && !isProviderEndpointOrigin(input.endpoint)) {
    throw new SmsKitError("CONFIG_INVALID", "invalid provider configuration");
  }
}

function connectionInputsChanged(current: ProviderConfig, input: UpdateProviderConfigInput): boolean {
  return current.status === "unconfigured" || current.accessKeyIdRef !== input.accessKeyIdRef ||
    current.accessKeySecretRef !== input.accessKeySecretRef ||
    current.receiptCallbackTokenRef !== input.receiptCallbackTokenRef || current.region !== input.region ||
    current.endpoint !== input.endpoint;
}

function configSnapshot(value: ConfiguredProviderConfig): Readonly<Record<string, unknown>> {
  return {
    kind: "provider-config",
    provider: value.provider,
    region: value.region,
    ...(value.endpoint === undefined ? {} : { endpoint: value.endpoint }),
    accessKeyIdRef: value.accessKeyIdRef,
    accessKeySecretRef: value.accessKeySecretRef,
    receiptCallbackTokenRef: value.receiptCallbackTokenRef,
    status: value.status,
    enabled: value.enabled,
    lastTestStatus: value.lastTestStatus,
    ...(value.lastTestSummary === undefined ? {} : { lastTestSummary: value.lastTestSummary }),
    ...(value.lastTestedAt === undefined ? {} : { lastTestedAt: value.lastTestedAt.toISOString() }),
    version: value.version,
  };
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) throw new TypeError(`invalid ${field}`);
  return result;
}

function configFromSnapshot(value: Readonly<Record<string, unknown>>): ConfiguredProviderConfig {
  if (value.kind !== "provider-config" || value.provider !== "aliyun" || typeof value.enabled !== "boolean" ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new TypeError("invalid provider config snapshot");
  const status = stringField(value, "status");
  const lastTestStatus = stringField(value, "lastTestStatus");
  if (!["untested", "ready", "degraded", "disabled"].includes(status) ||
      !["never", "succeeded", "failed"].includes(lastTestStatus)) throw new TypeError("invalid provider config status");
  const endpoint = value.endpoint;
  if (endpoint !== undefined && (typeof endpoint !== "string" || !isProviderEndpointOrigin(endpoint))) throw new TypeError("invalid endpoint");
  const testedAtValue = value.lastTestedAt;
  const testedAt = typeof testedAtValue === "string" ? new Date(testedAtValue) : undefined;
  if (testedAtValue !== undefined && (testedAt === undefined || Number.isNaN(testedAt.getTime()))) throw new TypeError("invalid testedAt");
  return {
    provider: "aliyun",
    region: stringField(value, "region"),
    ...(endpoint === undefined ? {} : { endpoint }),
    accessKeyIdRef: stringField(value, "accessKeyIdRef"),
    accessKeySecretRef: stringField(value, "accessKeySecretRef"),
    receiptCallbackTokenRef: stringField(value, "receiptCallbackTokenRef"),
    status: status as ConfiguredProviderConfig["status"],
    enabled: value.enabled,
    lastTestStatus: lastTestStatus as ConfiguredProviderConfig["lastTestStatus"],
    ...(value.lastTestSummary === undefined ? {} : { lastTestSummary: projectSafeEventMetadata(value.lastTestSummary) }),
    ...(testedAt === undefined ? {} : { lastTestedAt: testedAt }),
    version: value.version as number,
  };
}

function connectionTestSnapshot(value: ConnectionTestOutcome): Readonly<Record<string, unknown>> {
  return {
    kind: "config.connection-test",
    outcome: value.outcome,
    config: configSnapshot(value.config),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
  };
}

function connectionTestFromSnapshot(value: Readonly<Record<string, unknown>>): ConnectionTestOutcome {
  if (value.kind !== "config.connection-test" || (value.outcome !== "succeeded" && value.outcome !== "failed")) {
    throw new TypeError("invalid connection test snapshot");
  }
  const config = configFromSnapshot(value.config as Readonly<Record<string, unknown>>);
  if (value.outcome === "succeeded") {
    if (value.errorCode !== undefined) throw new TypeError("invalid connection test snapshot");
    return { config, outcome: "succeeded" };
  }
  if (value.errorCode === undefined) return { config, outcome: "failed" };
  if (value.errorCode !== "SECRET_UNRESOLVABLE" && value.errorCode !== "PROVIDER_UNAVAILABLE") {
    throw new TypeError("invalid connection test snapshot");
  }
  return { config, outcome: "failed", errorCode: value.errorCode };
}

function testConnectionError(code: NonNullable<ConnectionTestOutcome["errorCode"]>): SmsKitError {
  return code === "SECRET_UNRESOLVABLE"
    ? new SmsKitError("SECRET_UNRESOLVABLE", "provider credentials are unavailable")
    : new SmsKitError("PROVIDER_UNAVAILABLE", "provider connection test failed", true);
}

function assertTestConnectionInput(input: TestConnectionInput): void {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
      input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 512) {
    throw new SmsKitError("CONFIG_INVALID", "invalid provider connection test");
  }
}

function validatedConnectionTestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new SmsKitError("CONFIG_INVALID", "invalid provider connection test timeout");
  }
  return timeout;
}

function requireConfigVersion(config: ConfiguredProviderConfig, expectedVersion: number): void {
  if (config.version !== expectedVersion) {
    throw new SmsKitError("CONCURRENT_MODIFICATION", "provider configuration changed concurrently");
  }
}

function connectionSummary(connection: Awaited<ReturnType<SmsProvider["testConnection"]>>): SafeEventMetadata {
  if (!Number.isSafeInteger(connection.signatureCount) || connection.signatureCount < 0 ||
      !Number.isSafeInteger(connection.templateCount) || connection.templateCount < 0) {
    throw new SmsKitError("PROVIDER_UNAVAILABLE", "provider connection test failed", true);
  }
  return { counts: [
    { name: "signature" as const, value: connection.signatureCount },
    { name: "template" as const, value: connection.templateCount },
  ] };
}

function safeConnectionFailure(error: unknown): SmsKitError {
  if (error instanceof SmsKitError && error.code === "SECRET_UNRESOLVABLE") {
    return new SmsKitError("SECRET_UNRESOLVABLE", "provider credentials are unavailable");
  }
  return new SmsKitError("PROVIDER_UNAVAILABLE", "provider connection test failed", true);
}

/** Manages the singleton provider configuration; it never returns resolved secret values. */
export class ConfigService<Actor extends AuthorizationActor = AuthorizationActor> {
  private readonly connectionTestTimeoutMs: number;

  constructor(private readonly dependencies: ConfigServiceDependencies<Actor>) {
    this.connectionTestTimeoutMs = validatedConnectionTestTimeout(dependencies.connectionTestTimeoutMs);
  }

  async get(actor: Actor): Promise<ProviderConfig> {
    await this.dependencies.authorizer.assert(actor, "config.read");
    return this.dependencies.store.config.get();
  }

  async save(actor: Actor, input: UpdateProviderConfigInput): Promise<ProviderConfig> {
    await this.dependencies.authorizer.assert(actor, "config.write");
    assertConfigInput(input);
    const current = await this.dependencies.store.config.get();
    const resetReadiness = connectionInputsChanged(current, input);
    const result = await this.dependencies.store.transaction(async (tx) => {
      const saved = await this.dependencies.store.config.update({
        ...input,
        // A changed credential must be explicitly retested before it can send.
        enabled: resetReadiness ? false : input.enabled,
        resetReadiness,
      }, tx);
      await this.audit(actor, "config.save", "provider_config", undefined, tx);
      return saved;
    });
    await this.emit("config.saved");
    return result;
  }

  /** Applies the public PATCH contract with durable, tenant-fenced replay semantics. */
  async patch(actor: Actor, input: PatchProviderConfigInput): Promise<ProviderConfig> {
    await this.dependencies.authorizer.assert(actor, "config.write");
    if (input.idempotencyKey.trim().length === 0 || input.idempotencyKey.length > 512 ||
        (input.endpoint !== undefined && !isProviderEndpointOrigin(input.endpoint))) {
      throw new SmsKitError("CONFIG_INVALID", "invalid provider configuration");
    }
    const request = {
      provider: input.provider,
      region: input.region,
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      accessKeyIdRef: input.accessKeyIdRef,
      accessKeySecretRef: input.accessKeySecretRef,
      ...(input.receiptCallbackTokenRef === undefined ? {} : { receiptCallbackTokenRef: input.receiptCallbackTokenRef }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      expectedVersion: input.expectedVersion,
    };
    const execution = await executeAdminOperation({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "config.patch",
      idempotencyKey: input.idempotencyKey,
      request,
      encode: configSnapshot,
      decode: configFromSnapshot,
      work: async (tx) => {
        const current = await this.dependencies.store.config.get(tx);
        // PATCH cannot represent an explicit endpoint clear. Retain the stored
        // value when the field is omitted, just as we retain callback and
        // enabled. This also prevents an unrelated partial update from
        // resetting the tested credential/readiness state.
        const endpoint = input.endpoint ?? (current.status === "unconfigured" ? undefined : current.endpoint);
        const receiptCallbackTokenRef = input.receiptCallbackTokenRef ??
          (current.status === "unconfigured" ? undefined : current.receiptCallbackTokenRef);
        if (receiptCallbackTokenRef === undefined) {
          throw new SmsKitError("CONFIG_INVALID", "receipt callback token reference is required");
        }
        const update: UpdateProviderConfigInput = {
          provider: input.provider,
          region: input.region,
          ...(endpoint === undefined ? {} : { endpoint }),
          accessKeyIdRef: input.accessKeyIdRef,
          accessKeySecretRef: input.accessKeySecretRef,
          receiptCallbackTokenRef,
          enabled: input.enabled ?? current.enabled,
          expectedVersion: input.expectedVersion,
        };
        assertConfigInput(update);
        const resetReadiness = connectionInputsChanged(current, update);
        const saved = await this.dependencies.store.config.update({
          ...update,
          enabled: resetReadiness ? false : update.enabled,
          resetReadiness,
        }, tx);
        await this.audit(actor, "config.save", "provider_config", undefined, tx);
        configured(saved);
        return saved;
      },
    });
    if (!execution.replay) await this.emit("config.saved");
    return execution.value;
  }

  /**
   * Tests are versioned when invoked by the public admin API. The legacy
   * no-metadata form remains for existing non-HTTP compositions, but callers
   * cannot accidentally get its weaker retry behavior through the Next route.
   */
  async testConnection(actor: Actor, input?: TestConnectionInput): Promise<ProviderConfig> {
    await this.dependencies.authorizer.assert(actor, "config.write");
    return input === undefined
      ? this.testConnectionLegacy(actor)
      : this.testConnectionVersioned(actor, input);
  }

  private async testConnectionVersioned(actor: Actor, input: TestConnectionInput): Promise<ProviderConfig> {
    assertTestConnectionInput(input);
    const request = { expectedVersion: input.expectedVersion };
    const replay = await findAdminOperationReplay({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "config.test_connection",
      idempotencyKey: input.idempotencyKey,
      request,
      decode: connectionTestFromSnapshot,
    });
    if (replay !== undefined) {
      if (replay.errorCode !== undefined) throw testConnectionError(replay.errorCode);
      return replay.config;
    }

    const execution = await executeAdminOperation({
      store: this.dependencies.store,
      tenantId: actor.tenantId,
      operation: "config.test_connection",
      idempotencyKey: input.idempotencyKey,
      request,
      encode: connectionTestSnapshot,
      decode: connectionTestFromSnapshot,
      work: async (tx) => {
        const locked = await this.dependencies.store.config.get(tx);
        configured(locked);
        requireConfigVersion(locked, input.expectedVersion);
        // Claiming happens before this external I/O. A same-key concurrent
        // retry blocks on the durable claim and replays the completed safe
        // snapshot instead of probing the provider a second time.
        const outcome = await this.runConnectionTest(locked);
        const saved = await this.dependencies.store.config.recordConnectionTest({
          status: outcome.outcome,
          testedAt: this.dependencies.clock.now(),
          expectedVersion: input.expectedVersion,
          summary: outcome.summary,
        }, tx);
        configured(saved);
        await this.audit(
          actor,
          "config.test_connection",
          "provider_config",
          outcome.errorCode,
          tx,
          outcome.outcome,
        );
        return {
          config: saved,
          outcome: outcome.outcome,
          ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
        };
      },
    });
    if (!execution.replay) await this.emit("config.connection_tested");
    if (execution.value.errorCode !== undefined) throw testConnectionError(execution.value.errorCode);
    return execution.value.config;
  }

  private async testConnectionLegacy(actor: Actor): Promise<ProviderConfig> {
    const current = await this.dependencies.store.config.get();
    configured(current);
    const outcome = await this.runConnectionTest(current);
    const result = await this.dependencies.store.transaction(async (tx) => {
      const saved = await this.dependencies.store.config.recordConnectionTest({
        status: outcome.outcome,
        testedAt: this.dependencies.clock.now(),
        expectedVersion: current.version,
        summary: outcome.summary,
      }, tx);
      await this.audit(
        actor,
        "config.test_connection",
        "provider_config",
        outcome.errorCode,
        tx,
        outcome.outcome,
      );
      return saved;
    });
    await this.emit("config.connection_tested");
    if (outcome.errorCode !== undefined) throw testConnectionError(outcome.errorCode);
    return result;
  }

  /** Runs only resolvers/provider I/O; it never exposes or stores resolved credentials. */
  private async runConnectionTest(current: ConfiguredProviderConfig): Promise<Readonly<{
    outcome: "succeeded" | "failed";
    summary: ReturnType<typeof connectionSummary>;
    errorCode?: ConnectionTestOutcome["errorCode"];
  }>> {
    try {
      // A versioned test claims/locks before probing so a concurrent same-key
      // retry cannot issue a second probe. Its resolver/provider sequence must
      // nevertheless be finite: once this deadline wins, the transaction can
      // record a safe failure and release its config lock even if an SDK or
      // resolver ignores cancellation and never settles.
      const connection = await withProviderTimeout(async () => {
        // Prove the stored references are resolvable without retaining values.
        await Promise.all([
          this.dependencies.secretResolver.resolve(current.accessKeyIdRef),
          this.dependencies.secretResolver.resolve(current.accessKeySecretRef),
        ]);
        return this.dependencies.provider.testConnection({
          region: current.region,
          ...(current.endpoint === undefined ? {} : { endpoint: current.endpoint }),
          // The provider boundary resolves these references immediately for each call.
          accessKeyId: current.accessKeyIdRef,
          accessKeySecret: current.accessKeySecretRef,
        });
      }, this.connectionTestTimeoutMs);
      return {
        outcome: connection.status === "ready" ? "succeeded" : "failed",
        summary: connectionSummary(connection),
      };
    } catch (error) {
      // Resolver/provider messages may contain secrets; persist and replay only
      // the stable public error code.
      const safeError = safeConnectionFailure(error);
      return { outcome: "failed", summary: {}, errorCode: safeError.code as ConnectionTestOutcome["errorCode"] };
    }
  }

  private async audit(
    actor: Actor, action: string, targetType: string, errorCode: string | undefined,
    tx: Parameters<SmsStore["audits"]["append"]>[1], result: "succeeded" | "failed" = "succeeded",
  ): Promise<void> {
    await this.dependencies.store.audits.append({
      id: this.dependencies.ids.next(), tenantId: SYSTEM_TENANT_ID, actorId: actor.id,
      action, targetType, result, ...(errorCode === undefined ? {} : { errorCode }), occurredAt: this.dependencies.clock.now(),
    }, tx);
  }

  private async emit(name: string): Promise<void> {
    await this.dependencies.events.emit({ name, level: "info", metadata: { counts: [{ name: "resource", value: 1 }] } });
  }
}
