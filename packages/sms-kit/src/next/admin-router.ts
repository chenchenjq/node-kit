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
  testConnectionInputSchema,
  testSendInputSchema,
  updateProviderConfigSchema,
  updateSignatureInputSchema,
  updateTemplateInputSchema,
  updateVerificationSettingsInputSchema,
  verificationSettingsDtoSchema,
} from "./types/index.js";
import { failure, HttpError, parseJsonBody, success } from "./http.js";
import { configurationRoute, type SmsConfigRouteServices } from "./handlers/config.js";
import { operationJobAuthorization, operationsRoute, type SmsOperationsRouteServices } from "./handlers/operations.js";
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
  /** Concrete Task 4 operational services, including tenant-scoped job-origin resolution. */
  task4?: SmsOperationsRouteServices<Actor>;
  resolveJobAuthorization?: (input: SmsAdminJobAuthorizationInput<Actor>) => Promise<SmsAdminDeferredAuthorization | undefined>;
  dispatch?: (input: SmsAdminDispatchInput<Actor>) => Promise<SmsAdminDispatchResult>;
}>;

/**
 * Browser-cookie hosts must prove an unsafe request came from their own UI.
 * Bearer-token and service hosts can classify their requests as non-cookie so
 * they are not forced to synthesize browser Origin headers.
 */
export type SmsAdminCsrfProtection<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  /** Additional public origins when request.url reflects an internal proxy origin. */
  allowedOrigins?: readonly string[];
  /** Defaults to any Cookie presence; mixed hosts must classify the authenticated actor safely. */
  isCookieAuthenticated?(request: Request, actor: Actor): boolean | Promise<boolean>;
  /** Optional host-owned double-submit/session token check; it must not read the body. */
  verifyToken?(request: Request, actor: Actor): boolean | Promise<boolean>;
}>;

export type SmsAdminHandlerOptions<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
  basePath?: string;
  maxBodyBytes?: number;
  csrfProtection?: SmsAdminCsrfProtection<Actor>;
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
const resourceIdParamsSchema = z.strictObject({ id: z.uuid() });
const queryInteger = (maximum: number) => z.string().regex(/^[1-9][0-9]*$/).transform(Number)
  .pipe(z.number().int().safe().positive().max(maximum));
const paginationQuerySchema = z.strictObject({
  page: queryInteger(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: queryInteger(100).default(20),
});
const messageQueryTransportSchema = z.strictObject({
  page: queryInteger(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: queryInteger(100).default(20),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  acceptanceStatus: acceptanceStatusSchema.optional(),
  deliveryStatus: deliveryStatusSchema.optional(),
  templateKey: z.string().trim().min(1).max(256).optional(),
  purpose: z.string().trim().min(1).max(256).optional(),
  phone: z.string().trim().min(1).max(64).optional(),
}).superRefine((value, ctx) => {
  if (!Number.isSafeInteger((value.page - 1) * value.pageSize)) {
    ctx.addIssue({ code: "custom", path: ["page"], message: "page offset is too large" });
  }
  if ((value.from === undefined) !== (value.to === undefined)) {
    ctx.addIssue({ code: "custom", path: [value.from === undefined ? "from" : "to"], message: "from and to must be supplied together" });
  }
});
const statsQueryTransportSchema = z.strictObject({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  templateKey: z.string().trim().min(1).max(256).optional(),
  purpose: z.string().trim().min(1).max(256).optional(),
  acceptanceStatus: acceptanceStatusSchema.optional(),
  deliveryStatus: deliveryStatusSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.from === undefined) !== (value.to === undefined)) {
    ctx.addIssue({ code: "custom", path: [value.from === undefined ? "from" : "to"], message: "from and to must be supplied together" });
  }
});

const permission = (action: SmsAdminPermission): RouteAuthorization => ({ kind: "permission", action });

const routes: readonly Route[] = [
  { method: "GET", path: "/overview", authorization: { kind: "any", actions: ["config.read", "message.read", "stats.read"] }, responseSchema: smsOverviewDtoSchema },
  { method: "GET", path: "/config", authorization: permission("config.read"), responseSchema: providerConfigDtoSchema },
  { method: "PATCH", path: "/config", authorization: permission("config.write"), bodySchema: updateProviderConfigSchema, responseSchema: providerConfigDtoSchema },
  { method: "POST", path: "/config/test-connection", authorization: permission("config.write"), bodySchema: testConnectionInputSchema, responseSchema: connectionTestResultDtoSchema },
  { method: "POST", path: "/config/test-send", authorization: permission("sms.test"), bodySchema: testSendInputSchema, responseSchema: messageDtoSchema },
  { method: "POST", path: "/resources/sync-preview", authorization: permission("resource.sync"), bodySchema: resourceSyncPreviewInputSchema, responseSchema: resourceSyncPreviewDtoSchema },
  { method: "POST", path: "/resources/sync-commit", authorization: permission("resource.sync"), bodySchema: resourceSyncCommitInputSchema, responseSchema: resourceSyncCommitResultDtoSchema },
  { method: "GET", path: "/signatures", authorization: permission("config.read"), querySchema: paginationQuerySchema, responseSchema: signaturePageDtoSchema },
  { method: "PATCH", path: "/signatures/:id", authorization: permission("signature.manage"), bodySchema: updateSignatureInputSchema, paramsSchema: resourceIdParamsSchema, responseSchema: signatureDtoSchema },
  { method: "GET", path: "/templates", authorization: permission("config.read"), querySchema: paginationQuerySchema, responseSchema: templatePageDtoSchema },
  { method: "POST", path: "/templates/import", authorization: permission("template.manage"), bodySchema: importTemplateInputSchema, responseSchema: templateDtoSchema },
  { method: "PATCH", path: "/templates/:id", authorization: permission("template.manage"), bodySchema: updateTemplateInputSchema, paramsSchema: resourceIdParamsSchema, responseSchema: templateDtoSchema },
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

function canonicalOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.origin === "null" || parsed.username.length > 0 || parsed.password.length > 0 ||
        parsed.pathname !== "/" || parsed.search.length > 0 || parsed.hash.length > 0) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function configuredOrigins(protection: SmsAdminCsrfProtection | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const origin of protection?.allowedOrigins ?? []) {
    const normalized = canonicalOrigin(origin);
    if (normalized === undefined) throw new TypeError("allowedOrigins must contain serialized origins without paths or credentials");
    const parsed = new URL(normalized);
    const developmentLoopback = parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
    if (parsed.protocol !== "https:" && !developmentLoopback) {
      throw new TypeError("allowedOrigins must use HTTPS, except for an explicit loopback development origin");
    }
    result.add(normalized);
  }
  return result;
}

function assertJsonWrite(request: Request): void {
  const contentType = request.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "content type must be application/json");
  }
}

async function assertCsrfBoundary<Actor extends AuthorizationActor>(
  request: Request,
  actor: Actor,
  protection: SmsAdminCsrfProtection<Actor> | undefined,
  allowedOrigins: ReadonlySet<string>,
): Promise<void> {
  const cookieAuthenticated = await protection?.isCookieAuthenticated?.(request, actor) ?? request.headers.has("cookie");
  if (!cookieAuthenticated) return;

  const originHeader = request.headers.get("origin");
  const origin = originHeader === null ? undefined : canonicalOrigin(originHeader);
  const requestOrigin = new URL(request.url).origin;
  if (origin !== undefined && (origin === requestOrigin || allowedOrigins.has(origin))) return;
  if (await protection?.verifyToken?.(request, actor) === true) return;
  throw new HttpError(403, "request origin could not be verified", "PERMISSION_DENIED");
}

/**
 * The Task 2 router owns only trusted request context, exact route recognition,
 * and validation. Task-specific service dispatch is deliberately added by later
 * handlers, so no untrusted body field can become tenant or IP context here.
 */
export function createAdminRouter<Actor extends AuthorizationActor = AuthorizationActor>(options: SmsAdminHandlerOptions<Actor>) {
  const basePath = normalizedPath(options.basePath ?? "/api/admin/sms");
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  const allowedOrigins = configuredOrigins(options.csrfProtection);

  return async (request: Request): Promise<Response> => {
    const requestId = options.ids.next();
    try {
      const url = new URL(request.url);
      const matched = findRoute(request.method, routePath(url, basePath));
      if (matched === undefined) throw new HttpError(404, "route not found");
      const { route } = matched;

      if (route.bodySchema !== undefined) {
        // application/json is deliberately non-simple under CORS. Rejecting
        // form/text bodies closes the ambient-cookie simple-request path even
        // before the host performs authentication.
        assertJsonWrite(request);
      }

      const actor = await options.resolveActor(request);
      if (actor === null || !validActor(actor)) {
        throw new HttpError(401, "authentication required", "PERMISSION_DENIED");
      }
      if (route.bodySchema !== undefined) {
        await assertCsrfBoundary(request, actor, options.csrfProtection, allowedOrigins);
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
        const resolveAuthorization = options.services.task4?.store === undefined
          ? options.services.resolveJobAuthorization
          : (input: SmsAdminJobAuthorizationInput<Actor>) => operationJobAuthorization(options.services.task4!, input);
        if (resolveAuthorization === undefined) {
          throw new HttpError(500, "request failed", "STORAGE_FAILURE");
        }
        const resolvedAuthorization = await resolveAuthorization({ tenantId: actor.tenantId, jobId: params.id! });
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
      if (options.services.task4 !== undefined) {
        const data = await operationsRoute(options.services.task4, actor, route.path, body, params, query);
        if (data !== undefined) return success(responseData(route.responseSchema, data), requestId);
      }

      throw new HttpError(404, "route not found");
    } catch (error) {
      return failure(error, requestId);
    }
  };
}
