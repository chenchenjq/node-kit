import { describe, expect, it } from "vitest";

import { ConfigService } from "../../../src/application/config-service.js";
import type { ConfigRepository, ConfiguredProviderConfig, UpdateProviderConfigInput } from "../../../src/ports/store.js";
import type { ProviderAuthInput } from "../../../src/ports/provider.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";

const actor = { id: "operator", tenantId: "tenant-a" } as AuthorizationActor;
const readyConfig: ConfiguredProviderConfig = {
  provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ACCESS_KEY_ID",
  accessKeySecretRef: "env://ACCESS_KEY_SECRET", receiptCallbackTokenRef: "env://CALLBACK_TOKEN",
  status: "ready", enabled: true, lastTestStatus: "succeeded", version: 3,
};

describe("ConfigService", () => {
  it.each([
    ["non-HTTPS URL", "http://sms.example.test"],
    ["credentials", "https://user:secret@sms.example.test"],
    ["empty userinfo", "https://@sms.example.test"],
    ["empty username and password", "https://:@sms.example.test"],
    ["normalized dot path", "https://sms.example.test/a/.."],
    ["percent-encoded dot path", "https://sms.example.test/%2e"],
    ["query", "https://sms.example.test?secret=value"],
    ["overlong origin", `https://${Array.from({ length: 1_100 }, () => "a").join(".")}`],
  ])("rejects %s before a direct save or patch can persist it", async (_label, endpoint) => {
    let updates = 0;
    let claims = 0;
    const service = new ConfigService({
      store: {
        adminOperations: {
          find: async () => undefined,
          claim: async () => { claims += 1; return { kind: "claimed" }; },
          complete: async () => undefined,
        },
        config: {
          get: async () => readyConfig,
          update: async () => { updates += 1; return readyConfig; },
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {} as never,
      secretResolver: {} as never,
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => "endpoint-validation" },
      events: { emit: () => undefined },
    });
    const update = { ...readyConfig, endpoint, expectedVersion: readyConfig.version };

    await expect(service.save(actor, update)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(service.patch(actor, { ...update, provider: "aliyun", idempotencyKey: `endpoint:${_label}` }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect({ updates, claims }).toEqual({ updates: 0, claims: 0 });
  });

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
    let connectionSummary: unknown;
    const service = new ConfigService({
      store: {
        config: {
          get: async () => ({ ...readyConfig, status: "untested" as const, enabled: false, version: 4 }),
          update: async () => readyConfig,
          recordConnectionTest: async (input: Parameters<ConfigRepository["recordConnectionTest"]>[0]) => {
            connectionSummary = input.summary;
            return { ...readyConfig, status: input.status === "succeeded" ? "ready" as const : "degraded" as const, version: 5 };
          },
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
    expect(connectionSummary).toEqual({
      counts: [{ name: "signature", value: 1 }, { name: "template", value: 2 }],
    });
  });

  it("patches optional callback and enabled fields without replacing omitted values", async () => {
    let updateInput: UpdateProviderConfigInput | undefined;
    const service = new ConfigService({
      store: {
        adminOperations: {
          find: async () => undefined,
          claim: async () => ({ kind: "claimed" }),
          complete: async () => undefined,
        },
        config: {
          get: async () => readyConfig,
          update: async (input: UpdateProviderConfigInput) => {
            updateInput = input;
            return { ...readyConfig, ...input, version: 4 };
          },
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {} as never,
      secretResolver: {} as never,
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => "audit-patch" },
      events: { emit: () => undefined },
    });

    await service.patch(actor, {
      provider: "aliyun", region: readyConfig.region,
      accessKeyIdRef: readyConfig.accessKeyIdRef, accessKeySecretRef: readyConfig.accessKeySecretRef,
      expectedVersion: readyConfig.version, idempotencyKey: "config:preserve",
    });

    expect(updateInput).toMatchObject({
      receiptCallbackTokenRef: readyConfig.receiptCallbackTokenRef,
      enabled: true,
      expectedVersion: readyConfig.version,
    });
  });

  it("audits global configuration changes under the system tenant and normalizes secret failures", async () => {
    const audits: unknown[] = [];
    const service = new ConfigService({
      store: {
        config: {
          get: async () => readyConfig, update: async () => readyConfig,
          recordConnectionTest: async () => ({ ...readyConfig, status: "degraded" as const, version: 4 }),
        },
        audits: { append: async (event: unknown) => { audits.push(event); return event; } },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: {} as never,
      secretResolver: { resolve: async () => { throw new Error("resolved-secret-value must not escape"); } },
      authorizer: { assert: () => undefined }, clock: { now: () => new Date("2026-09-13T00:00:00.000Z") },
      ids: { next: () => "audit-3" }, events: { emit: () => undefined },
    });

    await service.save(actor, { ...readyConfig, expectedVersion: readyConfig.version });
    await expect(service.testConnection(actor)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE", message: "provider connection test failed",
    });

    expect(audits).toEqual([
      expect.objectContaining({ tenantId: "__system__", actorId: "operator", action: "config.save" }),
      expect.objectContaining({ tenantId: "__system__", actorId: "operator", action: "config.test_connection", errorCode: "PROVIDER_UNAVAILABLE" }),
    ]);
    expect(JSON.stringify(audits)).not.toContain("resolved-secret-value");
  });

  it("bounds a versioned connection probe so an unresponsive resolver cannot retain its transaction", async () => {
    let recorded = 0;
    let completed = 0;
    const service = new ConfigService({
      store: {
        adminOperations: {
          find: async () => undefined,
          claim: async () => ({ kind: "claimed" }),
          complete: async () => { completed += 1; },
        },
        config: {
          get: async () => readyConfig,
          update: async () => readyConfig,
          recordConnectionTest: async () => {
            recorded += 1;
            return { ...readyConfig, status: "degraded" as const, enabled: false, lastTestStatus: "failed" as const, version: 4 };
          },
        },
        audits: { append: async () => undefined },
        transaction: async (work: (tx: never) => Promise<unknown>) => work(undefined as never),
      } as never,
      provider: { testConnection: async () => new Promise<never>(() => undefined) } as never,
      secretResolver: { resolve: async () => new Promise<never>(() => undefined) },
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => "audit-timeout" },
      events: { emit: () => undefined },
      connectionTestTimeoutMs: 5,
    });

    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connection probe did not time out")), 100));
    await expect(Promise.race([
      service.testConnection(actor, { expectedVersion: readyConfig.version, idempotencyKey: "config:probe-timeout" }),
      deadline,
    ])).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "provider connection test failed" });

    expect(recorded).toBe(1);
    expect(completed).toBe(1);
  });
});
