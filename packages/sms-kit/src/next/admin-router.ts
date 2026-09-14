import { z } from "zod";

import type { IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import {
  acceptanceStatusSchema,
  connectionTestResultDtoSchema,
  deliveryStatusSchema,
  importTemplateInputSchema,
  isoDateTimeSchema,
  jobDtoSchema,
  messageDetailDtoSchema,
  messageDtoSchema,
  messagePageDtoSchema,
  providerConfigDtoSchema,
  reconcileInputSchema,
  receiptHealthDtoSchema,
  resourceSyncCommitInputSchema,
  resourceSyncCommitResultDtoSchema,
  resourceSyncPreviewInputSchema,
  resourceSyncPreviewDtoSchema,
  signatureDtoSchema,
  signaturePageDtoSchema,
  smsOverviewDtoSchema,
  smsStatsDtoSchema,
  templateDtoSchema,
  templatePageDtoSchema,
  testSendInputSchema,
  updateProviderConfigSchema,
  updateSignatureInputSchema,
  updateTemplateInputSchema,
  updateVerificationSettingsInputSchema,
  verificationSettingsDtoSchema,
} from "./types/index.js";
import { failure, HttpError, parseJsonBody, success } from "./http.js";
import { configurationRoute, type SmsConfigRouteServices } from "./handlers/config.js";
import { resourceRoute, type SmsResourceRouteServices } from "./handlers/resources.js";

export type SmsAdminRequestContext<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  actor: Actor;
  trustedIp: string | undefined;
  requestId: string;
}>;

export type SmsAdminRoute = Readonly<{ method: string; path: string }>;

export const smsAdminPermissions = [
  "config.read",
  "config.write",
  "resource.sync",
  "signature.manage",
  "template.manage",
  "sms.test",
  "message.read",
  "stats.read",
  "receipt.reconcile",
] as const;

export type SmsAdminPermission = typeof smsAdminPermissions[number];
export type SmsAdminJobReadPermission = "sms.test" | "receipt.reconcile";

export type SmsAdminAuthorizer<Actor extends AuthorizationActor = AuthorizationActor> = Authorizer<Actor> & Readonly<{
  assertAny(actor: Actor, actions: readonly SmsAdminPermission[]): Promise<void> | void;
}>;

export type SmsAdminDispatchInput<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  body: unknown;
  context: SmsAdminRequestContext<Actor>;
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, unknown>>;
  route: SmsAdminRoute;
}>;

export type SmsAdminDispatchResult = Readonly<{
  data: unknown;
}>;

export type SmsAdminJobAuthorizationInput<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  tenantId: Actor["tenantId"];
  jobId: string;
}>;

export type SmsAdminDeferredAuthorization = Readonly<{
  requiredPermission: SmsAdminJobReadPermission;
}>;

/**
 * Route implementations are host-composed in later tasks. They receive only
 * validated transport inputs plus the trusted context constructed here. A
 * deferred authorization resolver must perform only a tenant-scoped metadata
 * lookup inside context.actor.tenantId, return 404 for both missing and
 * other-tenant resources, and must not fetch a response DTO or mutate state.
 * The main dispatcher is not called until that originating action is allowed.
 */
export type SmsAdminServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  /** Concrete Task 3 services; transport validation and response DTO checks remain router-owned. */
  task3?: SmsConfigRouteServices<Actor> & SmsResourceRouteServices<Actor>;
  resolveJobAuthorization?: (input: SmsAdminJobAuthorizationInput<Actor>) => Promise<SmsAdminDeferredAuthorization | undefined>;
  dispatch?: (input: SmsAdminDispatchInput<Actor>) => Promise<SmsAdminDispatchResult>;
}>;

export type SmsAdminHandlerOptions<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  basePath?: string;
  maxBodyBytes?: number;
  resolveActor(request: Request): Promise<Actor | null>;
  resolveTrustedIp(request: Request): string | undefined;
  authorizer: SmsAdminAuthorizer<Actor>;
  services: SmsAdminServices<Actor>;
  ids: IdGenerator;
}>;

type RouteAuthorization =
  | Readonly<{ kind: "permission"; action: SmsAdminPermission }>
  | Readonly<{ kind: "any"; actions: readonly SmsAdminPermission[] }>
  | Readonly<{ kind: "deferred"; allowedActions: readonly SmsAdminJobReadPermission[] }>;

type Route = SmsAdminRoute & Readonly<{
  authorization: RouteAuthorization;
  bodySchema?: z.ZodType;
  allowsEmptyBody?: boolean;
  paramsSchema?: z.ZodType<Readonly<Record<string, string>>>;
  querySchema?: z.ZodType<Readonly<Record<string, unknown>>>;
  responseSchema: z.ZodType;
}>;

const emptyJsonObjectSchema = z.strictObject({});
const idParamsSchema = z.strictObject({ id: z.string().trim().min(1).max(256) });
const queryInteger = (maximum: number) => z.string().regex(/^[1-9][0-9]*$/).transform(Number)
  .pipe(z.number().int().safe().positive().max(maximum));
const paginationQuerySchema = z.strictObject({
  page: queryInteger(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: queryInteger(100).default(20),
});
const messageQueryTransportSchema = z.strictObject({
  page: queryInteger(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: queryInteger(100).default(20),
  acceptanceStatus: acceptanceStatusSchema.optional(),
  deliveryStatus: deliveryStatusSchema.optional(),
  templateKey: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).max(64).optional(),
});
const statsQueryTransportSchema = z.strictObject({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  templateKey: z.string().trim().min(1).optional(),
});

const permission = (action: SmsAdminPermission): RouteAuthorization => ({ kind: "permission", action });

const routes: readonly Route[] = [
  { method: "GET", path: "/overview", authorization: { kind: "any", actions: ["config.read", "message.read", "stats.read"] }, responseSchema: smsOverviewDtoSchema },
  { method: "GET", path: "/config", authorization: permission("config.read"), responseSchema: providerConfigDtoSchema },
  { method: "PATCH", path: "/config", authorization: permission("config.write"), bodySchema: updateProviderConfigSchema, responseSchema: providerConfigDtoSchema },
  { method: "POST", path: "/config/test-connection", authorization: permission("config.write"), bodySchema: emptyJsonObjectSchema, allowsEmptyBody: true, responseSchema: connectionTestResultDtoSchema },
  { method: "POST", path: "/config/test-send", authorization: permission("sms.test"), bodySchema: testSendInputSchema, responseSchema: messageDtoSchema },
  { method: "POST", path: "/resources/sync-preview", authorization: permission("resource.sync"), bodySchema: resourceSyncPreviewInputSchema, responseSchema: resourceSyncPreviewDtoSchema },
  { method: "POST", path: "/resources/sync-commit", authorization: permission("resource.sync"), bodySchema: resourceSyncCommitInputSchema, responseSchema: resourceSyncCommitResultDtoSchema },
  { method: "GET", path: "/signatures", authorization: permission("config.read"), querySchema: paginationQuerySchema, responseSchema: signaturePageDtoSchema },
  { method: "PATCH", path: "/signatures/:id", authorization: permission("signature.manage"), bodySchema: updateSignatureInputSchema, paramsSchema: idParamsSchema, responseSchema: signatureDtoSchema },
  { method: "GET", path: "/templates", authorization: permission("config.read"), querySchema: paginationQuerySchema, responseSchema: templatePageDtoSchema },
  { method: "POST", path: "/templates/import", authorization: permission("template.manage"), bodySchema: importTemplateInputSchema, responseSchema: templateDtoSchema },
  { method: "PATCH", path: "/templates/:id", authorization: permission("template.manage"), bodySchema: updateTemplateInputSchema, paramsSchema: idParamsSchema, responseSchema: templateDtoSchema },
  { method: "GET", path: "/verification", authorization: permission("config.read"), responseSchema: verificationSettingsDtoSchema },
  { method: "PATCH", path: "/verification", authorization: permission("config.write"), bodySchema: updateVerificationSettingsInputSchema, responseSchema: verificationSettingsDtoSchema },
  { method: "GET", path: "/receipt-health", authorization: permission("message.read"), responseSchema: receiptHealthDtoSchema },
  { method: "POST", path: "/reconcile", authorization: permission("receipt.reconcile"), bodySchema: reconcileInputSchema, responseSchema: jobDtoSchema },
  { method: "GET", path: "/messages", authorization: permission("message.read"), querySchema: messageQueryTransportSchema, responseSchema: messagePageDtoSchema },
  { method: "GET", path: "/messages/:id", authorization: permission("message.read"), paramsSchema: idParamsSchema, responseSchema: messageDetailDtoSchema },
  { method: "GET", path: "/stats", authorization: permission("stats.read"), querySchema: statsQueryTransportSchema, responseSchema: smsStatsDtoSchema },
  { method: "GET", path: "/jobs/:id", authorization: { kind: "deferred", allowedActions: ["sms.test", "receipt.reconcile"] }, paramsSchema: idParamsSchema, responseSchema: jobDtoSchema },
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

function matchPath(pattern: string, path: string): Readonly<Record<string, string>> | undefined {
  const expected = pattern.split("/").slice(1);
  const actual = path.split("/").slice(1);
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedSegment = expected[index]!;
    const actualSegment = actual[index]!;
    if (!expectedSegment.startsWith(":")) {
      if (actualSegment !== expectedSegment) return undefined;
      continue;
    }
    if (actualSegment.length === 0) return undefined;
    try {
      params[expectedSegment.slice(1)] = decodeURIComponent(actualSegment);
    } catch {
      throw new HttpError(400, "invalid path parameter");
    }
  }
  return params;
}

type MatchedRoute = Readonly<{ route: Route; params: Readonly<Record<string, string>> }>;

function findRoute(method: string, path: string | undefined): MatchedRoute | undefined {
  if (path === undefined) return undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, path);
    if (params !== undefined) return { route, params };
  }
  return undefined;
}

function validActor(actor: AuthorizationActor): boolean {
  return typeof actor.id === "string" && actor.id.trim().length > 0 &&
    typeof actor.tenantId === "string" && actor.tenantId.trim().length > 0;
}

async function assertInitialAuthorization<Actor extends AuthorizationActor>(authorization: RouteAuthorization, authorizer: SmsAdminAuthorizer<Actor>, actor: Actor): Promise<void> {
  if (authorization.kind === "permission") await authorizer.assert(actor, authorization.action);
  if (authorization.kind === "any") await authorizer.assertAny(actor, authorization.actions);
}

function parseQuery(searchParams: URLSearchParams, schema: Route["querySchema"]): Readonly<Record<string, unknown>> {
  const query = Object.create(null) as Record<string, string>;
  for (const [key, value] of searchParams) {
    if (Object.hasOwn(query, key)) throw new HttpError(400, "query parameter must not be repeated");
    query[key] = value;
  }
  return (schema ?? emptyJsonObjectSchema).parse(query) as Readonly<Record<string, unknown>>;
}

function dispatchResult(value: unknown): SmsAdminDispatchResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(500, "request failed", "STORAGE_FAILURE");
  }
  const keys = Object.keys(value);
  if (!Object.hasOwn(value, "data") || keys.some((key) => key !== "data")) {
    throw new HttpError(500, "request failed", "STORAGE_FAILURE");
  }
  return value as SmsAdminDispatchResult;
}

function deferredAuthorization(
  value: unknown,
  allowedActions: readonly SmsAdminJobReadPermission[],
): SmsAdminDeferredAuthorization {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Object.hasOwn(value, "requiredPermission")) {
    throw new HttpError(500, "request failed", "STORAGE_FAILURE");
  }
  const requiredPermission = (value as { requiredPermission?: unknown }).requiredPermission;
  if (typeof requiredPermission !== "string" || !allowedActions.includes(requiredPermission as SmsAdminJobReadPermission)) {
    throw new HttpError(500, "request failed", "STORAGE_FAILURE");
  }
  return { requiredPermission: requiredPermission as SmsAdminJobReadPermission };
}

function responseData(schema: z.ZodType, data: unknown): unknown {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpError(500, "request failed", "STORAGE_FAILURE");
  return parsed.data;
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
      const matched = findRoute(request.method, routePath(url, basePath));
      if (matched === undefined) throw new HttpError(404, "route not found");
      const { route } = matched;

      const actor = await options.resolveActor(request);
      if (actor === null || !validActor(actor)) {
        throw new HttpError(401, "authentication required", "PERMISSION_DENIED");
      }
      await assertInitialAuthorization(route.authorization, options.authorizer, actor);
      // These values are intentionally sourced only from host callbacks. This
      // context is prepared now for later route handlers and never read from a
      // body, URL query, or arbitrary request header.
      const context: SmsAdminRequestContext<Actor> = {
        actor,
        trustedIp: options.resolveTrustedIp(request),
        requestId,
      };

      const query = parseQuery(url.searchParams, route.querySchema);
      const params = (route.paramsSchema ?? emptyJsonObjectSchema).parse(matched.params) as Readonly<Record<string, string>>;

      const body = route.bodySchema === undefined
        ? request.body === null ? undefined : (() => { throw new HttpError(400, "request body is not allowed"); })()
        : request.body === null && route.allowsEmptyBody ? undefined : route.bodySchema.parse(await parseJsonBody(request, maxBodyBytes));
      const dispatchInput: SmsAdminDispatchInput<Actor> = {
        body,
        context,
        params,
        query,
        route: { method: route.method, path: route.path },
      };
      if (route.authorization.kind === "deferred") {
        if (options.services.resolveJobAuthorization === undefined) {
          throw new HttpError(500, "request failed", "STORAGE_FAILURE");
        }
        const resolvedAuthorization = await options.services.resolveJobAuthorization({ tenantId: actor.tenantId, jobId: params.id! });
        if (resolvedAuthorization === undefined) throw new HttpError(404, "job not found");
        const authorization = deferredAuthorization(resolvedAuthorization, route.authorization.allowedActions);
        await options.authorizer.assert(actor, authorization.requiredPermission);
      }
      if (options.services.dispatch !== undefined) {
        const result = dispatchResult(await options.services.dispatch(dispatchInput));
        return success(responseData(route.responseSchema, result.data), requestId);
      }
      if (options.services.task3 !== undefined) {
        const data = await configurationRoute(options.services.task3, actor, route.path, body);
        const task3Data = data === undefined
          ? await resourceRoute(options.services.task3, actor, route.path, body, params, query)
          : data;
        if (task3Data !== undefined) return success(responseData(route.responseSchema, task3Data), requestId);
      }

      throw new HttpError(404, "route not found");
    } catch (error) {
      return failure(error, requestId);
    }
  };
}
