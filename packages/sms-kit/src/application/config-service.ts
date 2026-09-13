import { SmsKitError } from "../core/errors.js";
import type { SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink, IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor, SecretResolver } from "../ports/security.js";
import type { ConfiguredProviderConfig, ProviderConfig, SmsStore, UpdateProviderConfigInput } from "../ports/store.js";

export type ConfigServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  store: SmsStore;
  provider: SmsProvider;
  secretResolver: SecretResolver;
  authorizer: Authorizer<Actor>;
  clock: Clock;
  ids: Pick<IdGenerator, "next">;
  events: EventSink;
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
  if (input.endpoint !== undefined && input.endpoint.trim().length === 0) {
    throw new SmsKitError("CONFIG_INVALID", "invalid provider configuration");
  }
}

function credentialsChanged(current: ProviderConfig, input: UpdateProviderConfigInput): boolean {
  return current.status === "unconfigured" || current.accessKeyIdRef !== input.accessKeyIdRef ||
    current.accessKeySecretRef !== input.accessKeySecretRef ||
    current.receiptCallbackTokenRef !== input.receiptCallbackTokenRef;
}

/** Manages the singleton provider configuration; it never returns resolved secret values. */
export class ConfigService<Actor extends AuthorizationActor = AuthorizationActor> {
  constructor(private readonly dependencies: ConfigServiceDependencies<Actor>) {}

  async get(actor: Actor): Promise<ProviderConfig> {
    await this.dependencies.authorizer.assert(actor, "config.read");
    return this.dependencies.store.config.get();
  }

  async save(actor: Actor, input: UpdateProviderConfigInput): Promise<ProviderConfig> {
    await this.dependencies.authorizer.assert(actor, "config.write");
    assertConfigInput(input);
    const current = await this.dependencies.store.config.get();
    const resetReadiness = credentialsChanged(current, input);
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

  async testConnection(actor: Actor): Promise<ProviderConfig> {
    await this.dependencies.authorizer.assert(actor, "config.write");
    const current = await this.dependencies.store.config.get();
    configured(current);

    try {
      // Prove the stored references are resolvable without retaining the values.
      await Promise.all([
        this.dependencies.secretResolver.resolve(current.accessKeyIdRef),
        this.dependencies.secretResolver.resolve(current.accessKeySecretRef),
      ]);
      const connection = await this.dependencies.provider.testConnection({
        region: current.region,
        ...(current.endpoint === undefined ? {} : { endpoint: current.endpoint }),
        // The provider boundary resolves these references immediately for each call.
        accessKeyId: current.accessKeyIdRef,
        accessKeySecret: current.accessKeySecretRef,
      });
      const status = connection.status === "ready" ? "succeeded" as const : "failed" as const;
      const result = await this.dependencies.store.transaction(async (tx) => {
        const saved = await this.dependencies.store.config.recordConnectionTest({
          status,
          testedAt: this.dependencies.clock.now(),
          expectedVersion: current.version,
          summary: { counts: [{ name: "resource", value: connection.signatureCount + connection.templateCount }] },
        }, tx);
        await this.audit(actor, "config.test_connection", "provider_config", undefined, tx);
        return saved;
      });
      await this.emit("config.connection_tested");
      return result;
    } catch (error) {
      // A failed test still transitions the exact version that was tested; secret
      // resolver/provider errors are deliberately propagated without copying text.
      try {
        await this.dependencies.store.transaction(async (tx) => {
          await this.dependencies.store.config.recordConnectionTest({
            status: "failed", testedAt: this.dependencies.clock.now(), expectedVersion: current.version,
            summary: { counts: [{ name: "resource", value: 0 }] },
          }, tx);
          await this.audit(actor, "config.test_connection", "provider_config", "SECRET_UNRESOLVABLE", tx, "failed");
        });
      } catch (recordError) {
        if (recordError instanceof SmsKitError && recordError.code === "CONCURRENT_MODIFICATION") throw recordError;
      }
      throw error;
    }
  }

  private async audit(
    actor: Actor, action: string, targetType: string, errorCode: string | undefined,
    tx: Parameters<SmsStore["audits"]["append"]>[1], result: "succeeded" | "failed" = "succeeded",
  ): Promise<void> {
    await this.dependencies.store.audits.append({
      id: this.dependencies.ids.next(), tenantId: actor.tenantId, actorId: actor.id,
      action, targetType, result, ...(errorCode === undefined ? {} : { errorCode }), occurredAt: this.dependencies.clock.now(),
    }, tx);
  }

  private async emit(name: string): Promise<void> {
    await this.dependencies.events.emit({ name, level: "info", metadata: { counts: [{ name: "resource", value: 1 }] } });
  }
}
