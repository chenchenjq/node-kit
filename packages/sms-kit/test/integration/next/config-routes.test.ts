import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { HealthService } from "../../../src/application/health-service.js";
import { createSmsAdminHandler } from "../../../src/next/index.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";

const admin = { id: "admin-1", tenantId: "tenant-a" as AuthorizationActor["tenantId"], permissions: ["config.read", "config.write", "sms.test", "stats.read"] } as const;
const reader = { ...admin, permissions: ["config.read"] } as const;

const rawConfig = {
  provider: "aliyun" as const, status: "ready" as const, enabled: true, region: "cn-hangzhou",
  accessKeyIdRef: "env://ALIYUN_ACCESS_KEY_ID", accessKeySecretRef: "env://ALIYUN_ACCESS_KEY_SECRET",
  receiptCallbackTokenRef: "env://SMS_CALLBACK_TOKEN", lastTestStatus: "succeeded" as const,
  lastTestedAt: new Date("2026-09-14T00:00:00.000Z"), version: 7,
};

function handlerFor(actor: AuthorizationActor, task3: unknown) {
  return createSmsAdminHandler({
    resolveActor: async () => actor, resolveTrustedIp: () => "203.0.113.9",
    authorizer: {
      assert: (candidate, action) => {
        if (!(candidate.permissions ?? []).includes(action)) throw new SmsKitError("PERMISSION_DENIED", "not allowed");
      },
      assertAny: (candidate, actions) => {
        if (!actions.some((action) => (candidate.permissions ?? []).includes(action))) throw new SmsKitError("PERMISSION_DENIED", "not allowed");
      },
    },
    services: { task3 } as never,
    ids: { next: () => "req-1", messageId: () => "message-1" as never },
  });
}

describe("sms configuration routes", () => {
  it("returns the signature and template counts recorded by the connection test", async () => {
    const handler = handlerFor(admin, {
      config: {
        testConnection: async () => ({
          ...rawConfig,
          lastTestSummary: { counts: [{ name: "signature", value: 7 }, { name: "template", value: 11 }] },
        }),
      },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config/test-connection", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 7, idempotencyKey: "connection:1" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { signatureCount: 7, templateCount: 11 } });
  });

  it("projects overview and configuration through safe DTOs without returning secret references", async () => {
    const handler = handlerFor(admin, {
      health: { getSnapshot: async ({ tenantId }: { tenantId: string }) => ({ tenantId, status: "ready", providerStatus: "ready", pendingJobs: 2, acceptanceUnknown: 0, finalUnknown: 1, unmatchedReceipts: 3, systemBudgetRemaining: 9, circuitOpen: false, warnings: [] }) },
      config: { get: async () => rawConfig },
    });

    const overview = await handler(new Request("https://app.test/api/admin/sms/overview"));
    const config = await handler(new Request("https://app.test/api/admin/sms/config"));
    const configBody = await config.json();

    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ data: { status: "ready", deliveryUnknown: 1, unmatchedCount: 3 } });
    expect(config.status).toBe(200);
    expect(configBody.data.accessKeyIdRef).toEqual({ scheme: "env", maskedName: "ALIYUN_***_ID", configured: true });
    expect(JSON.stringify(configBody)).not.toContain("ACCESS_KEY");
    expect(JSON.stringify(configBody)).not.toContain("CALLBACK_TOKEN");
  });

  it.each([
    { configStatus: "ready" as const, enabled: true, circuitOpen: true, status: "degraded", providerStatus: "ready" },
    { configStatus: "untested" as const, enabled: false, circuitOpen: false, status: "disabled", providerStatus: "untested" },
    { configStatus: "disabled" as const, enabled: false, circuitOpen: false, status: "disabled", providerStatus: "disabled" },
  ])("reports provider configuration $providerStatus independently from $status health", async ({
    configStatus, enabled, circuitOpen, status, providerStatus,
  }) => {
    const health = new HealthService({
      store: {
        config: { get: async () => ({ ...rawConfig, status: configStatus, enabled }) },
        policy: { get: async () => ({ systemDailyBudget: null, circuitOpen }) },
        health: { snapshot: async () => ({
          pendingJobs: 0,
          waitingMessages: 0,
          usableTemplates: 1,
          acceptanceUnknown: 0,
          finalUnknown: 0,
          unmatchedReceipts: 0,
          heldBudgetCount: 0,
        }) },
      } as never,
      clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
    });
    const handler = handlerFor(admin, { health });

    const response = await handler(new Request("https://app.test/api/admin/sms/overview"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status, providerStatus, circuitOpen } });
  });

  it("safely projects a legal single-label secret reference", async () => {
    const handler = handlerFor(admin, {
      config: {
        get: async () => ({
          ...rawConfig,
          accessKeyIdRef: "env://ID",
          accessKeySecretRef: "env://SECRET",
          receiptCallbackTokenRef: "env://TOKEN",
        }),
      },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        accessKeyIdRef: { scheme: "env", maskedName: "***", configured: true },
        accessKeySecretRef: { scheme: "env", maskedName: "***", configured: true },
      },
    });
  });

  it("requires sms.test for a one-time test send before its phone can reach a service", async () => {
    let sends = 0;
    const handler = handlerFor(reader, {
      send: { enqueueTestNotification: async () => { sends += 1; throw new Error("must not run"); } },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config/test-send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 7, idempotencyKey: "test:1", phone: "+8613800138000", templateKey: "notice.shipped", variables: {}, purpose: "notification" }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "PERMISSION_DENIED" } });
    expect(sends).toBe(0);
  });

  it("does not echo the one-time test phone when projecting a sent message", async () => {
    const handler = handlerFor(admin, {
      send: { enqueueTestNotification: async () => ({
        id: "message-1", phoneMasked: "138****8000", phoneLast4: "8000", templateKeySnapshot: "notice.shipped", purpose: "notification",
        acceptanceStatus: "accepted", deliveryStatus: "waiting", submittedAt: new Date("2026-09-14T00:00:00.000Z"), providerBizId: "biz-1", finalErrorCode: undefined,
      }) },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config/test-send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 7, idempotencyKey: "test:1", phone: "+8613800138000", templateKey: "notice.shipped", variables: {}, purpose: "notification" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.phone).toEqual({ masked: "138****8000", last4Available: true });
    expect(JSON.stringify(body)).not.toContain("13800138000");
  });

  it("forwards the public config fence and trusted actor to the dedicated test-send operation", async () => {
    let received: unknown;
    const handler = handlerFor(admin, {
      send: { enqueueTestNotification: async (actor: AuthorizationActor, input: unknown) => {
        received = { actor, input };
        return {
          id: "message-2", phoneMasked: "138****8000", phoneLast4: "8000", templateKeySnapshot: "notice.shipped",
          purpose: "notification", acceptanceStatus: "pending", deliveryStatus: "not_applicable",
          submittedAt: new Date("2026-09-14T00:00:00.000Z"),
        };
      } },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config/test-send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 7, idempotencyKey: "test:fenced", phone: "+8613800138000", templateKey: "notice.shipped", variables: { orderNo: "A-100" }, purpose: "notification" }),
    }));

    expect(response.status).toBe(200);
    expect(received).toEqual({
      actor: admin,
      input: {
        expectedVersion: 7, idempotencyKey: "test:fenced", phone: "+8613800138000", templateKey: "notice.shipped",
        variables: { orderNo: "A-100" }, purpose: "notification",
      },
    });
  });
});
