import { z } from "zod";

import type { IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import {
  importTemplateInputSchema,
  reconcileInputSchema,
  resourceSyncCommitInputSchema,
  resourceSyncPreviewInputSchema,
  testSendInputSchema,
  updateProviderConfigSchema,
  updateSignatureInputSchema,
  updateTemplateInputSchema,
  updateVerificationSettingsInputSchema,
} from "./types/index.js";
import { failure, HttpError, parseJsonBody } from "./http.js";

export type SmsAdminRequestContext<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  actor: Actor;
  trustedIp: string | undefined;
  request: Request;
  requestId: string;
  url: URL;
}>;

export type SmsAdminRoute = Readonly<{ method: string; path: string }>;

export type SmsAdminDispatchInput<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  body: unknown;
  context: SmsAdminRequestContext<Actor>;
  route: SmsAdminRoute;
}>;

/**
 * Route implementations are host-composed in later tasks. Their only request
 * context is the one constructed by this router, so tenant and IP values cannot
 * be supplied by the caller's body, query string, or headers.
 */
export type SmsAdminServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  dispatch?: (input: SmsAdminDispatchInput<Actor>) => Promise<Response>;
}>;

export type SmsAdminHandlerOptions<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  basePath?: string;
  maxBodyBytes?: number;
  resolveActor(request: Request): Promise<Actor | null>;
  resolveTrustedIp(request: Request): string | undefined;
  authorizer: Authorizer<Actor>;
  services: SmsAdminServices<Actor>;
  ids: IdGenerator;
}>;

type Route = SmsAdminRoute & Readonly<{
  bodySchema?: z.ZodType;
  allowsEmptyBody?: boolean;
  permission: string;
}>;

const emptyJsonObjectSchema = z.strictObject({});

const routes: readonly Route[] = [
  { method: "GET", path: "/overview", permission: "config.read" },
  { method: "GET", path: "/config", permission: "config.read" },
  { method: "PATCH", path: "/config", permission: "config.write", bodySchema: updateProviderConfigSchema },
  { method: "POST", path: "/config/test-connection", permission: "config.write", bodySchema: emptyJsonObjectSchema, allowsEmptyBody: true },
  { method: "POST", path: "/config/test-send", permission: "sms.test", bodySchema: testSendInputSchema },
  { method: "POST", path: "/resources/sync-preview", permission: "resource.sync", bodySchema: resourceSyncPreviewInputSchema },
  { method: "POST", path: "/resources/sync-commit", permission: "resource.sync", bodySchema: resourceSyncCommitInputSchema },
  { method: "GET", path: "/signatures", permission: "config.read" },
  { method: "PATCH", path: "/signatures/:id", permission: "signature.manage", bodySchema: updateSignatureInputSchema },
  { method: "GET", path: "/templates", permission: "config.read" },
  { method: "POST", path: "/templates/import", permission: "template.manage", bodySchema: importTemplateInputSchema },
  { method: "PATCH", path: "/templates/:id", permission: "template.manage", bodySchema: updateTemplateInputSchema },
  { method: "GET", path: "/verification", permission: "config.read" },
  { method: "PATCH", path: "/verification", permission: "config.write", bodySchema: updateVerificationSettingsInputSchema },
  { method: "GET", path: "/receipt-health", permission: "message.read" },
  { method: "POST", path: "/reconcile", permission: "receipt.reconcile", bodySchema: reconcileInputSchema },
  { method: "GET", path: "/messages", permission: "message.read" },
  { method: "GET", path: "/messages/:id", permission: "message.read" },
  { method: "GET", path: "/stats", permission: "stats.read" },
  { method: "GET", path: "/jobs/:id", permission: "message.read" },
];

function normalizedPath(path: string): string {
  if (path.length === 0) return "/";
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  return prefixed === "/" ? prefixed : prefixed.replace(/\/+$/, "");
}

function routePath(url: URL, basePath: string): string | undefined {
  const pathname = normalizedPath(url.pathname);
  if (pathname === basePath) return "/";
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  return pathname.slice(basePath.length);
}

function matchesPath(pattern: string, path: string): boolean {
  const expected = pattern.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  return expected.length === actual.length && expected.every((segment, index) => segment.startsWith(":")
    ? actual[index] !== undefined && actual[index].length > 0
    : actual[index] === segment);
}

function findRoute(method: string, path: string | undefined): Route | undefined {
  if (path === undefined) return undefined;
  return routes.find((route) => route.method === method && matchesPath(route.path, path));
}

function validActor(actor: AuthorizationActor): boolean {
  return typeof actor.id === "string" && actor.id.trim().length > 0 &&
    typeof actor.tenantId === "string" && actor.tenantId.trim().length > 0;
}

/**
 * The Task 2 router owns only trusted request context, exact route recognition,
 * and validation. Task-specific service dispatch is deliberately added by later
 * handlers, so no untrusted body field can become tenant or IP context here.
 */
export function createAdminRouter<Actor extends AuthorizationActor = AuthorizationActor>(options: SmsAdminHandlerOptions<Actor>) {
  const basePath = normalizedPath(options.basePath ?? "/api/admin/sms");
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;

  return async (request: Request): Promise<Response> => {
    const requestId = options.ids.next();
    try {
      const url = new URL(request.url);
      const route = findRoute(request.method, routePath(url, basePath));
      if (route === undefined) throw new HttpError(404, "route not found");

      const actor = await options.resolveActor(request);
      if (actor === null || !validActor(actor)) {
        throw new HttpError(401, "authentication required", "PERMISSION_DENIED");
      }
      await options.authorizer.assert(actor, route.permission);
      // These values are intentionally sourced only from host callbacks. This
      // context is prepared now for later route handlers and never read from a
      // body, URL query, or arbitrary request header.
      const context: SmsAdminRequestContext<Actor> = {
        actor,
        trustedIp: options.resolveTrustedIp(request),
        request,
        requestId,
        url,
      };

      if (url.searchParams.has("tenantId")) {
        throw new HttpError(400, "tenantId must be resolved by the host");
      }

      const body = route.bodySchema === undefined
        ? request.body === null ? undefined : (() => { throw new HttpError(400, "request body is not allowed"); })()
        : request.body === null && route.allowsEmptyBody ? undefined : route.bodySchema.parse(await parseJsonBody(request, maxBodyBytes));
      if (options.services.dispatch !== undefined) {
        return await options.services.dispatch({
          body,
          context,
          route: { method: route.method, path: route.path },
        });
      }

      throw new HttpError(404, "route not found");
    } catch (error) {
      return failure(error, requestId);
    }
  };
}
