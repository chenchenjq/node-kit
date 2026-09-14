import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ConfigService } from "../../../src/application/config-service.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { TenantId } from "../../../src/core/types.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";
import { createSmsAdminHandler } from "../../../src/next/index.js";
import { migrateSmsKit } from "../../../src/postgres/migrator.js";
import { PgSmsStore } from "../../../src/postgres/store.js";
import { startPostgres } from "../postgres/helpers.js";

const tenantA = {
  id: "admin-a", tenantId: "tenant-config-a" as TenantId, permissions: ["config.read", "config.write"],
} as AuthorizationActor;
const tenantB = {
  id: "admin-b", tenantId: "tenant-config-b" as TenantId, permissions: ["config.read", "config.write"],
} as AuthorizationActor;

describe("configuration routes with PostgreSQL", () => {
  let stop: (() => Promise<void>) | undefined;
  let store: PgSmsStore;
  let service: ConfigService<AuthorizationActor>;
  let connectionTests = 0;
  let connectionTestImplementation: (() => Promise<{
    status: "ready";
    signatureCount: number;
    templateCount: number;
  }>) | undefined;

  beforeAll(async () => {
    const postgres = await startPostgres();
    stop = postgres.stop;
    await migrateSmsKit(postgres.pool);
    store = new PgSmsStore(postgres.pool);
    service = new ConfigService({
      store,
      provider: {
        testConnection: async () => {
          connectionTests += 1;
          if (connectionTestImplementation !== undefined) return connectionTestImplementation();
          return { status: "ready", signatureCount: 7, templateCount: 11 };
        },
      } as never,
      secretResolver: { resolve: async (reference) => `resolved:${reference}` },
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => randomUUID() },
      events: { emit: () => undefined },
    });
  }, 120_000);

  afterAll(async () => stop?.());

  function handler(actor: AuthorizationActor) {
    return createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.10",
      authorizer: {
        assert: (candidate, action) => {
          if (!(candidate.permissions ?? []).includes(action)) throw new SmsKitError("PERMISSION_DENIED", "not allowed");
        },
        assertAny: () => undefined,
      },
      services: { task3: { config: service } },
      ids: { next: () => randomUUID(), messageId: () => randomUUID() as never },
    });
  }

  async function json(actor: AuthorizationActor, path: string, method: string, body?: unknown) {
    return handler(actor)(new Request(`https://app.test/api/admin/sms${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }));
  }

  it("preserves omitted config fields, replays one mutation, and returns real connection counts", async () => {
    const initial = {
      version: 0, idempotencyKey: "config:initial", provider: "aliyun", region: "cn-hangzhou",
      endpoint: "https://sms.example.test",
      accessKeyIdRef: "env://ALIYUN_ACCESS_KEY_ID", accessKeySecretRef: "env://ALIYUN_ACCESS_KEY_SECRET",
      receiptCallbackTokenRef: "env://SMS_CALLBACK_TOKEN", enabled: true,
    };
    const created = await json(tenantA, "/config", "PATCH", initial);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ data: { version: 1, enabled: false, status: "untested" } });

    const testConnection = { version: 1, idempotencyKey: "config:test-connection" };
    const tested = await json(tenantA, "/config/test-connection", "POST", testConnection);
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({
      data: { status: "succeeded", signatureCount: 7, templateCount: 11, config: { version: 2 } },
    });
    const replayedTest = await json(tenantA, "/config/test-connection", "POST", testConnection);
    expect(replayedTest.status).toBe(200);
    expect(await replayedTest.json()).toMatchObject({ data: { config: { version: 2 } } });
    expect(connectionTests).toBe(1);

    const enable = {
      version: 2, idempotencyKey: "config:enable", provider: "aliyun", region: "cn-hangzhou",
      accessKeyIdRef: "env://ALIYUN_ACCESS_KEY_ID", accessKeySecretRef: "env://ALIYUN_ACCESS_KEY_SECRET",
      enabled: true,
    };
    const enabled = await json(tenantA, "/config", "PATCH", enable);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ data: {
      version: 3, enabled: true, status: "ready", endpoint: "https://sms.example.test",
    } });

    const disabled = await json(tenantA, "/config", "PATCH", { ...enable, version: 3, idempotencyKey: "config:disable", enabled: false });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ data: { version: 4, enabled: false, status: "disabled" } });

    const replay = await json(tenantA, "/config", "PATCH", enable);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ data: { version: 3, enabled: true, status: "ready" } });

    const changedReplay = await json(tenantA, "/config", "PATCH", { ...enable, enabled: false });
    expect(changedReplay.status).toBe(409);
    expect(await changedReplay.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });

    const crossTenant = await json(tenantB, "/config", "PATCH", enable);
    expect(crossTenant.status).toBe(409);
    expect(await crossTenant.json()).toMatchObject({ error: { code: "CONCURRENT_MODIFICATION" } });
  });

  it("claims a versioned connection test before provider I/O so concurrent retries run it once", async () => {
    const current = await service.get(tenantA);
    if (current.status === "unconfigured") throw new Error("provider configuration is missing");
    const input = { version: current.version, idempotencyKey: "config:connection-concurrent" };
    let providerCalls = 0;
    let entered!: () => void;
    let release!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const providerRelease = new Promise<void>((resolve) => { release = resolve; });
    connectionTestImplementation = async () => {
      providerCalls += 1;
      entered();
      await providerRelease;
      return { status: "ready", signatureCount: 7, templateCount: 11 };
    };

    try {
      const first = json(tenantA, "/config/test-connection", "POST", input);
      await providerEntered;
      const second = json(tenantA, "/config/test-connection", "POST", input);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(providerCalls).toBe(1);
      release();

      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(await firstResponse.json()).toMatchObject({ data: { signatureCount: 7, templateCount: 11 } });
      expect(await secondResponse.json()).toMatchObject({ data: { signatureCount: 7, templateCount: 11 } });
      expect(providerCalls).toBe(1);
    } finally {
      // Keep the test's transaction gate from leaking when an assertion turns
      // red; resolving an already resolved promise is harmless.
      release();
      connectionTestImplementation = undefined;
    }
  });

  it("does not reuse a successful connection test after credentials change through disable and enable", async () => {
    const current = await service.get(tenantA);
    const oldCredentials = {
      provider: "aliyun" as const,
      region: "cn-hangzhou",
      accessKeyIdRef: "env://ALIYUN_ACCESS_KEY_ID_OLD",
      accessKeySecretRef: "env://ALIYUN_ACCESS_KEY_SECRET_OLD",
      receiptCallbackTokenRef: "env://SMS_CALLBACK_TOKEN_OLD",
    };
    const operation = randomUUID();
    const normalized = await json(tenantA, "/config", "PATCH", {
      ...oldCredentials,
      version: current.version,
      idempotencyKey: `config:readiness:${operation}:normalize`,
      enabled: false,
    });
    expect(normalized.status).toBe(200);
    const normalizedConfig = await service.get(tenantA);
    if (normalizedConfig.status === "unconfigured") throw new Error("provider configuration is missing");

    const callsBeforeTest = connectionTests;
    const tested = await json(tenantA, "/config/test-connection", "POST", {
      version: normalizedConfig.version,
      idempotencyKey: `config:readiness:${operation}:test-old`,
    });
    expect(tested.status).toBe(200);
    const testedConfig = await service.get(tenantA);
    if (testedConfig.status === "unconfigured") throw new Error("provider configuration is missing");

    const enabledOld = await json(tenantA, "/config", "PATCH", {
      ...oldCredentials,
      version: testedConfig.version,
      idempotencyKey: `config:readiness:${operation}:enable-old`,
      enabled: true,
    });
    expect(enabledOld.status).toBe(200);
    const enabledOldConfig = await service.get(tenantA);
    if (enabledOldConfig.status === "unconfigured") throw new Error("provider configuration is missing");
    expect(enabledOldConfig).toMatchObject({ status: "ready", enabled: true, lastTestStatus: "succeeded" });

    const newCredentials = {
      ...oldCredentials,
      accessKeyIdRef: "env://ALIYUN_ACCESS_KEY_ID_NEW",
      accessKeySecretRef: "env://ALIYUN_ACCESS_KEY_SECRET_NEW",
    };
    const changed = await json(tenantA, "/config", "PATCH", {
      ...newCredentials,
      version: enabledOldConfig.version,
      idempotencyKey: `config:readiness:${operation}:change`,
      enabled: true,
    });
    expect(changed.status).toBe(200);
    const changedConfig = await service.get(tenantA);
    if (changedConfig.status === "unconfigured") throw new Error("provider configuration is missing");
    expect(changedConfig).toMatchObject({ status: "untested", enabled: false, lastTestStatus: "never" });
    expect(changedConfig.lastTestSummary).toBeUndefined();
    expect(changedConfig.lastTestedAt).toBeUndefined();

    const disabled = await json(tenantA, "/config", "PATCH", {
      ...newCredentials,
      version: changedConfig.version,
      idempotencyKey: `config:readiness:${operation}:disable-new`,
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    const disabledConfig = await service.get(tenantA);
    if (disabledConfig.status === "unconfigured") throw new Error("provider configuration is missing");
    expect(disabledConfig).toMatchObject({ status: "disabled", enabled: false, lastTestStatus: "never" });

    const reenabled = await json(tenantA, "/config", "PATCH", {
      ...newCredentials,
      version: disabledConfig.version,
      idempotencyKey: `config:readiness:${operation}:enable-new`,
      enabled: true,
    });
    expect(reenabled.status).toBe(200);
    expect(await service.get(tenantA)).toMatchObject({
      status: "untested",
      enabled: true,
      lastTestStatus: "never",
    });
    expect(connectionTests).toBe(callsBeforeTest + 1);
  });

  it("falls back to a fully redacted label for a persisted legal secret reference", async () => {
    const current = await service.get(tenantA);
    const operation = randomUUID();
    const reference = "env://ALIYUN_SECRET_1";
    const updated = await json(tenantA, "/config", "PATCH", {
      version: current.version,
      idempotencyKey: `config:safe-reference:${operation}`,
      provider: "aliyun",
      region: "cn-hangzhou",
      accessKeyIdRef: "env://ALIYUN_ACCESS_KEY_ID",
      accessKeySecretRef: reference,
      receiptCallbackTokenRef: "env://SMS_CALLBACK_TOKEN",
      enabled: false,
    });

    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody).toMatchObject({
      data: { accessKeySecretRef: { scheme: "env", maskedName: "***", configured: true } },
    });
    expect(JSON.stringify(updatedBody)).not.toContain(reference);

    const read = await json(tenantA, "/config", "GET");
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody).toMatchObject({
      data: { accessKeySecretRef: { scheme: "env", maskedName: "***", configured: true } },
    });
    expect(JSON.stringify(readBody)).not.toContain(reference);
  });

  it("times out an unresponsive connection probe, replays its safe failure, and releases the config fence", async () => {
    const current = await service.get(tenantA);
    if (current.status === "unconfigured") throw new Error("provider configuration is missing");
    let providerCalls = 0;
    const timedOut = new ConfigService({
      store,
      provider: {
        testConnection: async () => {
          providerCalls += 1;
          return new Promise<never>(() => undefined);
        },
      } as never,
      secretResolver: { resolve: async (reference) => `resolved:${reference}` },
      authorizer: { assert: () => undefined },
      clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
      ids: { next: () => randomUUID() },
      events: { emit: () => undefined },
      connectionTestTimeoutMs: 20,
    });
    const input = { expectedVersion: current.version, idempotencyKey: "config:connection-timeout" };

    await expect(timedOut.testConnection(tenantA, input)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(timedOut.testConnection(tenantA, input)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(providerCalls).toBe(1);

    const failed = await service.get(tenantA);
    expect(failed).toMatchObject({ version: current.version + 1, lastTestStatus: "failed" });
    if (failed.status === "unconfigured") throw new Error("provider configuration is missing");
    await expect(service.patch(tenantA, {
      provider: "aliyun", region: failed.region,
      ...(failed.endpoint === undefined ? {} : { endpoint: failed.endpoint }),
      accessKeyIdRef: failed.accessKeyIdRef,
      accessKeySecretRef: failed.accessKeySecretRef,
      receiptCallbackTokenRef: failed.receiptCallbackTokenRef,
      enabled: false,
      expectedVersion: failed.version,
      idempotencyKey: "config:after-timeout",
    })).resolves.toMatchObject({ version: failed.version + 1, status: "disabled" });
  });
});
