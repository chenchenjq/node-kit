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

const authorizer = { assert: () => undefined, assertAny: () => undefined };

const unconfiguredProvider = {
  provider: "aliyun",
  status: "unconfigured",
  enabled: false,
  lastTestStatus: "never",
  version: 0,
} as const;

const overview = {
  status: "unconfigured",
  providerStatus: "unconfigured",
  pendingJobs: 0,
  acceptanceUnknown: 0,
  deliveryUnknown: 0,
  unmatchedCount: 0,
  systemBudgetRemaining: null,
  circuitOpen: false,
  warnings: [],
} as const;

const reconcileJob = {
  id: "job-a",
  jobType: "reconcile",
  state: "pending",
  availableAt: "2026-09-14T00:00:00.000Z",
  attemptCount: 0,
  maxAttempts: 3,
} as const;

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

    const malformed = await handler(new Request("https://app.test/api/admin/sms/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{bad",
    }));
    const oversized = await handler(new Request("https://app.test/api/admin/sms/config", {
      method: "PATCH",
      headers: { "content-length": "21", "content-type": "application/json" },
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
      services: { dispatch: async () => { dispatches += 1; return { data: unconfiguredProvider }; } },
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
          return { data: unconfiguredProvider };
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
      authorizer: {
        assert: () => { throw new SmsKitError("PERMISSION_DENIED", "private authorization detail"); },
        assertAny: () => { throw new SmsKitError("PERMISSION_DENIED", "private authorization detail"); },
      },
      services: { dispatch: async () => { dispatches += 1; return { data: unconfiguredProvider }; } },
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
      services: { dispatch: async () => { dispatches += 1; return { data: { status: "succeeded", testedAt: "2026-09-14T00:00:00.000Z", signatureCount: 0, templateCount: 0, config: unconfiguredProvider } }; } },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const tenant = await handler(new Request("https://app.test/api/admin/sms/config/test-connection", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId: "tenant-b" }),
    }));
    const oversized = await handler(new Request("https://app.test/api/admin/sms/config/test-connection", {
      method: "POST",
      headers: { "content-length": "101", "content-type": "application/json" },
      body: "x".repeat(101),
    }));

    expect(tenant.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(dispatches).toBe(0);
  });

  it("requires JSON and a host-compatible CSRF boundary for cookie-authenticated writes", async () => {
    let actorResolutions = 0;
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => {
        actorResolutions += 1;
        return actor;
      },
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      csrfProtection: {
        allowedOrigins: ["http://localhost:3000"],
        // A mixed host classifies only a token it has actually authenticated;
        // a caller cannot bypass CSRF with an arbitrary Authorization header.
        isCookieAuthenticated: (request) => request.headers.has("cookie") &&
          request.headers.get("authorization") !== "Bearer service-token",
        verifyToken: (request) => request.headers.get("x-csrf-token") === "host-verified-token",
      },
      services: {
        dispatch: async () => {
          dispatches += 1;
          return {
            data: {
              status: "succeeded",
              testedAt: "2026-09-14T00:00:00.000Z",
              signatureCount: 0,
              templateCount: 0,
              config: unconfiguredProvider,
            },
          };
        },
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });
    const request = (headers: Record<string, string>) => handler(new Request(
      "https://internal.service/api/admin/sms/config/test-connection",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ version: 1, idempotencyKey: "csrf:test-connection" }),
      },
    ));

    const simple = await request({ "content-type": "text/plain" });
    const crossOriginCookie = await request({
      "content-type": "application/json",
      cookie: "session=browser-session",
      origin: "https://attacker.example",
    });
    const trustedProxyOrigin = await request({
      "content-type": "application/json; charset=utf-8",
      cookie: "session=browser-session",
      origin: "http://localhost:3000",
    });
    const hostTokenFallback = await request({
      "content-type": "application/json",
      cookie: "session=browser-session",
      "x-csrf-token": "host-verified-token",
    });
    const bearerService = await request({
      "content-type": "application/json",
      authorization: "Bearer service-token",
      // Infrastructure cookies must not accidentally turn an explicitly
      // bearer-authenticated service call into a browser-cookie request.
      cookie: "load-balancer=affinity",
    });
    const bogusBearerCookie = await request({
      "content-type": "application/json",
      authorization: "Bearer attacker-controlled",
      cookie: "session=browser-session",
    });

    expect(simple.status).toBe(415);
    expect(crossOriginCookie.status).toBe(403);
    expect(bogusBearerCookie.status).toBe(403);
    expect([trustedProxyOrigin.status, hostTokenFallback.status, bearerService.status]).toEqual([200, 200, 200]);
    expect(actorResolutions).toBe(5);
    expect(dispatches).toBe(3);
  });

  it("fails closed when a Cookie request has an unclassified Authorization header", async () => {
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => undefined,
      authorizer,
      services: {
        dispatch: async () => ({ data: {
          status: "succeeded",
          testedAt: "2026-09-14T00:00:00.000Z",
          signatureCount: 0,
          templateCount: 0,
          config: unconfiguredProvider,
        } }),
      },
      ids: { next: () => "req-default-csrf", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config/test-connection", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer unverified",
        cookie: "session=browser-session",
      },
      body: JSON.stringify({ version: 1, idempotencyKey: "csrf:default-fail-closed" }),
    }));

    expect(response.status).toBe(403);
  });

  it("authorizes overview when the actor has any one read permission", async () => {
    const checked: string[] = [];
    const statsReader = { ...actor, permissions: ["stats.read"] } as const satisfies AuthorizationActor;
    const handler = createSmsAdminHandler({
      resolveActor: async () => statsReader,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer: {
        assert: () => undefined,
        assertAny: (resolvedActor, actions) => {
          const granted = actions.find((action) => (resolvedActor.permissions as readonly string[]).includes(action));
          if (granted === undefined) throw new SmsKitError("PERMISSION_DENIED", "denied");
          checked.push(granted);
        },
      },
      services: { dispatch: async () => ({ data: overview }) },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/overview"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: overview, requestId: "req-1" });
    expect(checked).toEqual(["stats.read"]);
  });

  it("rejects overview before dispatch when every read permission is denied", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer: {
        assert: () => { throw new SmsKitError("PERMISSION_DENIED", "private detail"); },
        assertAny: () => { throw new SmsKitError("PERMISSION_DENIED", "private detail"); },
      },
      services: { dispatch: async () => { dispatches += 1; return { data: overview }; } },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/overview"));

    expect(response.status).toBe(403);
    expect(dispatches).toBe(0);
  });

  it("uses an explicit any-permission authorizer for actors without permission lists", async () => {
    const derivedActor = { id: "derived-admin", tenantId: actor.tenantId } satisfies AuthorizationActor;
    const checked: string[][] = [];
    const handler = createSmsAdminHandler({
      resolveActor: async () => derivedActor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer: {
        assert: () => { throw new Error("single-action authorization must not be used"); },
        assertAny: (_actor, actions) => { checked.push([...actions]); },
      },
      services: { dispatch: async () => ({ data: overview }) },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/overview"));

    expect(response.status).toBe(200);
    expect(checked).toEqual([["config.read", "message.read", "stats.read"]]);
  });

  it("defers job permission until dispatch resolves a tenant-scoped job", async () => {
    const checked: string[] = [];
    const seen: Array<{ tenantId: string; params: Readonly<Record<string, string>> }> = [];
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer: { assert: (_actor, action) => { checked.push(action); }, assertAny: () => undefined },
      services: {
        // A partial Task 4 host must retain the legacy deferred resolver until
        // it supplies the tenant-scoped operation store.
        task4: {} as never,
        resolveJobAuthorization: async ({ tenantId, jobId }) => {
          seen.push({ tenantId, params: { id: jobId } });
          return { requiredPermission: "receipt.reconcile" };
        },
        dispatch: async () => ({ data: reconcileJob }),
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/jobs/job-a"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: reconcileJob, requestId: "req-1" });
    expect(checked).toEqual(["receipt.reconcile"]);
    expect(seen).toEqual([{ tenantId: "tenant-a", params: { id: "job-a" } }]);
  });

  it("does not expose a resolved job before its originating permission succeeds", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer: {
        assert: (_actor, action) => {
          if (action !== "message.read") throw new SmsKitError("PERMISSION_DENIED", "private detail");
        },
        assertAny: () => undefined,
      },
      services: {
        resolveJobAuthorization: async () => ({ requiredPermission: "receipt.reconcile" }),
        dispatch: async () => { dispatches += 1; return { data: reconcileJob }; },
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/jobs/job-a"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: { code: "PERMISSION_DENIED", message: "permission denied", retryable: false },
      requestId: "req-1",
    });
    expect(JSON.stringify(body)).not.toContain("job-a");
    expect(dispatches).toBe(0);
  });

  it("fails closed when a deferred job route has no authorization resolver", async () => {
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: { dispatch: async () => ({ data: reconcileJob }) },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/jobs/job-a"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "STORAGE_FAILURE", message: "request failed", retryable: false },
      requestId: "req-1",
    });
  });

  it("returns not found for an other-tenant job before permission checks or DTO dispatch", async () => {
    let authorizations = 0;
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer: { assert: () => { authorizations += 1; }, assertAny: () => undefined },
      services: {
        resolveJobAuthorization: async ({ tenantId, jobId }) => {
          if (`${tenantId}:${jobId}` !== "tenant-b:job-b") return undefined;
          return { requiredPermission: "receipt.reconcile" };
        },
        dispatch: async () => { dispatches += 1; return { data: reconcileJob }; },
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/jobs/job-b"));

    expect(response.status).toBe(404);
    expect(authorizations).toBe(0);
    expect(dispatches).toBe(0);
  });

  it("rejects an unrelated permission from job authorization metadata", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: {
        resolveJobAuthorization: async () => ({ requiredPermission: "config.read" }) as never,
        dispatch: async () => { dispatches += 1; return { data: reconcileJob }; },
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/jobs/job-a"));

    expect(response.status).toBe(500);
    expect(dispatches).toBe(0);
  });

  it("rejects unknown, route-inapplicable, and duplicate query parameters before dispatch", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: { dispatch: async () => { dispatches += 1; return { data: unconfiguredProvider }; } },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const unknown = await handler(new Request("https://app.test/api/admin/sms/config?debug=true"));
    const wrongRoute = await handler(new Request("https://app.test/api/admin/sms/config?page=1"));
    const duplicate = await handler(new Request("https://app.test/api/admin/sms/messages?page=1&page=2"));
    const prototypeKey = await handler(new Request("https://app.test/api/admin/sms/config?__proto__=ignored"));

    expect([unknown.status, wrongRoute.status, duplicate.status, prototypeKey.status]).toEqual([400, 400, 400, 400]);
    expect(dispatches).toBe(0);
  });

  it("does not collapse duplicate path separators into a registered route", async () => {
    let dispatches = 0;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: { dispatch: async () => { dispatches += 1; return { data: unconfiguredProvider }; } },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms//config"));

    expect(response.status).toBe(404);
    expect(dispatches).toBe(0);
  });

  it("passes only parsed query and path inputs instead of the raw request URL", async () => {
    let received: unknown;
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: {
        dispatch: async (input) => {
          received = input;
          return { data: { items: [], page: 2, pageSize: 10, total: 0 } };
        },
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/messages?page=2&pageSize=10"));

    expect(response.status).toBe(200);
    expect(received).toMatchObject({ query: { page: 2, pageSize: 10 }, params: {} });
    expect((received as { context: object }).context).not.toHaveProperty("url");
    expect((received as { context: object }).context).not.toHaveProperty("request");
  });

  it("owns success envelopes and rejects a raw Response from dispatch", async () => {
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: {
        dispatch: async () => Response.json({ data: unconfiguredProvider, requestId: "forged" }) as never,
      },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "STORAGE_FAILURE", message: "request failed", retryable: false },
      requestId: "req-1",
    });
  });

  it("validates dispatch data against the route DTO before responding", async () => {
    const handler = createSmsAdminHandler({
      resolveActor: async () => actor,
      resolveTrustedIp: () => "203.0.113.9",
      authorizer,
      services: { dispatch: async () => ({ data: { ...unconfiguredProvider, leakedSecret: "do-not-return" } }) },
      ids: { next: () => "req-1", messageId: () => "message-1" as never },
    });

    const response = await handler(new Request("https://app.test/api/admin/sms/config"));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: { code: "STORAGE_FAILURE", message: "request failed", retryable: false },
      requestId: "req-1",
    });
    expect(JSON.stringify(body)).not.toContain("do-not-return");
  });
});
