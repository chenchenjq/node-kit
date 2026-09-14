import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
  it("projects overview and configuration through safe DTOs without returning secret references", async () => {
    const handler = handlerFor(admin, {
      health: { getSnapshot: async ({ tenantId }: { tenantId: string }) => ({ tenantId, status: "ready", pendingJobs: 2, acceptanceUnknown: 0, finalUnknown: 1, unmatchedReceipts: 3, systemBudgetRemaining: 9, circuitOpen: false, warnings: [] }) },
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

  it("requires sms.test for a one-time test send before its phone can reach a service", async () => {
    let sends = 0;
    const handler = handlerFor(reader, {
      send: { enqueueNotification: async () => { sends += 1; throw new Error("must not run"); } },
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
      send: { enqueueNotification: async () => ({
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
});
