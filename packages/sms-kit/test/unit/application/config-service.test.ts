import { describe, expect, it } from "vitest";

import { ConfigService } from "../../../src/application/config-service.js";
import type { ConfigRepository, ConfiguredProviderConfig, UpdateProviderConfigInput } from "../../../src/ports/store.js";
import type { ProviderAuthInput } from "../../../src/ports/provider.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";

const actor = { id: "operator", tenantId: "system" } as AuthorizationActor;
const readyConfig: ConfiguredProviderConfig = {
  provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ACCESS_KEY_ID",
  accessKeySecretRef: "env://ACCESS_KEY_SECRET", receiptCallbackTokenRef: "env://CALLBACK_TOKEN",
  status: "ready", enabled: true, lastTestStatus: "succeeded", version: 3,
};

describe("ConfigService", () => {
  it("returns configuration to untested after a credential reference changes", async () => {
    let saved: ConfiguredProviderConfig | undefined;
    const service = new ConfigService({
      store: {
        config: {
          get: async () => readyConfig,
          update: async (input: UpdateProviderConfigInput) => {
            saved = { ...readyConfig, ...input, status: "untested", enabled: input.enabled, version: 4 };
            return saved;
          },
          recordConnectionTest: async () => readyConfig,
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {} as never,
      secretResolver: {} as never,
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => "audit-1" },
      events: { emit: () => undefined },
    });

    const result = await service.save(actor, { ...readyConfig, accessKeySecretRef: "env://NEW_SECRET", expectedVersion: readyConfig.version });

    expect(result).toMatchObject({ status: "untested", enabled: false, version: 4 });
    expect(saved).toMatchObject({ accessKeySecretRef: "env://NEW_SECRET", enabled: false });
  });

  it("marks a successfully tested configuration ready without persisting resolved credentials", async () => {
    const resolved: string[] = [];
    let connectionInput: unknown;
    const service = new ConfigService({
      store: {
        config: {
          get: async () => ({ ...readyConfig, status: "untested" as const, enabled: false, version: 4 }),
          update: async () => readyConfig,
          recordConnectionTest: async (input: Parameters<ConfigRepository["recordConnectionTest"]>[0]) => ({ ...readyConfig, status: input.status === "succeeded" ? "ready" as const : "degraded" as const, version: 5 }),
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: { testConnection: async (input: ProviderAuthInput) => { connectionInput = input; return { status: "ready" as const, signatureCount: 1, templateCount: 2 }; } } as never,
      secretResolver: { resolve: async (reference) => { resolved.push(reference); return `resolved:${reference}`; } },
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => "audit-2" }, events: { emit: () => undefined },
    });

    await expect(service.testConnection(actor)).resolves.toMatchObject({ status: "ready", version: 5 });

    expect(resolved).toEqual(["env://ACCESS_KEY_ID", "env://ACCESS_KEY_SECRET"]);
    expect(connectionInput).toMatchObject({ accessKeyId: "env://ACCESS_KEY_ID", accessKeySecret: "env://ACCESS_KEY_SECRET" });
    expect(JSON.stringify(connectionInput)).not.toContain("resolved:");
  });
});
