import { describe, expect, it, vi } from "vitest";

// Route handlers execute on the server; Vitest is not a Next.js module graph.
vi.mock("server-only", () => ({}));

import { createSmsAdminHandler } from "../../../src/next/index.js";
import { SmsKitError } from "../../../src/core/errors.js";
import type { AuthorizationActor } from "../../../src/ports/security.js";

const actor = {
  id: "admin-1",
  tenantId: "tenant-a" as AuthorizationActor["tenantId"],
  permissions: ["config.read"],
} as const satisfies AuthorizationActor;

const authorizer = { assert: () => undefined };

function createHandler(resolveActor: (request: Request) => Promise<AuthorizationActor | null>) {
  return createSmsAdminHandler({
    resolveActor,
    resolveTrustedIp: () => "203.0.113.9",
    authorizer,
    services: {},
    ids: { next: () => "req-1", messageId: () => "message-1" as never },
  });
}

describe("sms admin router", () => {
  it("returns the stable envelope when no actor resolves", async () => {
    const handler = createHandler(async () => null);

    const response = await handler(new Request("https://app.test/api/admin/sms/config"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "PERMISSION_DENIED", message: "authentication required", retryable: false },
      requestId: "req-1",
    });
  });

  it("matches only registered methods and normalized route paths", async () => {
    const handler = createHandler(async () => actor);
    const unauthenticated = createHandler(async () => null);

    expect((await handler(new Request("https://app.test/api/admin/sms/not-config"))).status).toBe(404);
    expect((await handler(new Request("https://app.test/api/admin/sms/config", { method: "DELETE" }))).status).toBe(404);
    expect((await unauthenticated(new Request("https://app.test/api/admin/sms/config/"))).status).toBe(401);
  });

  it("rejects malformed JSON and a JSON body above the configured byte limit", async () => {
    const handler = createSmsAdminHandler({
      maxBodyBytes: 20,
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: {},
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const malformed = await handler(new Request("https://app.test/api/admin/sms/config", { method: "PATCH", body: "{bad" }));
    const oversized = await handler(new Request("https://app.test/api/admin/sms/config", {
      method: "PATCH",
      headers: { "content-length": "21" },
      body: "x".repeat(21),
    }));

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("rejects a client-controlled tenant field before an operational route can use it", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: { dispatch: async () => { dispatches += 1; return Response.json({ data: {}, requestId: "req-1" }); } },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });
    const response = await handler(new Request("https://app.test/api/admin/sms/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        idempotencyKey: "config:1",
        region: "cn-hangzhou",
        accessKeyIdRef: "env://ALIYUN_ID",
        accessKeySecretRef: "env://ALIYUN_SECRET",
        tenantId: "tenant-b",
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "CONFIG_INVALID" }, requestId: "req-1" });
    expect(dispatches).toBe(0);
  });

  it("passes tenant and IP only from the host resolvers to a registered operation", async () => {
    const received: Array<{ tenantId: string; trustedIp: string | undefined }> = [];
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: {
        dispatch: async ({ context }) => {
          received.push({ tenantId: context.actor.tenantId, trustedIp: context.trustedIp });
          return Response.json({ data: {}, requestId: context.requestId });
        },
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });
    const input = {
      version: 1,
      idempotencyKey: "config:1",
      region: "cn-hangzhou",
      accessKeyIdRef: "env://ALIYUN_ID",
      accessKeySecretRef: "env://ALIYUN_SECRET",
    };

    const response = await handler(new Request("https://app.test/api/admin/sms/config", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-tenant-id": "tenant-b", "x-forwarded-for": "198.51.100.8" },
      body: JSON.stringify(input),
    }));
    const tenantQuery = await handler(new Request("https://app.test/api/admin/sms/config?tenantId=tenant-b", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }));

    expect(response.status).toBe(200);
    expect(received).toEqual([{ tenantId: "tenant-a", trustedIp: "203.0.113.9" }]);
    expect(tenantQuery.status).toBe(400);
    expect(received).toHaveLength(1);
  });

  it("blocks unauthorized actors before dispatching a registered route", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer: { assert: () => { throw new SmsKitError("PERMISSION_DENIED", "private authorization detail"); } },
      services: { dispatch: async () => { dispatches += 1; return Response.json({ data: {}, requestId: "req-1" }); } },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config"));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "PERMISSION_DENIED", message: "permission denied" } });
    expect(dispatches).toBe(0);
  });

  it("bounds and strictly validates an otherwise empty POST body", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      maxBodyBytes: 100,
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: { dispatch: async () => { dispatches += 1; return Response.json({ data: {}, requestId: "req-1" }); } },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const tenant = await handler(new Request("https://app.test/api/admin/sms/config/test-connection", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: "tenant-b" }),
    }));
    const oversized = await handler(new Request("https://app.test/api/admin/sms/config/test-connection", {
      method: "POST", headers: { "content-length": "101" }, body: "x".repeat(101),
    }));

    expect(tenant.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(dispatches).toBe(0);
  });
});
