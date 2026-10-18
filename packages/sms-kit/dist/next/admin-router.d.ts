import type { IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import { type SmsConfigRouteServices } from "./handlers/config.js";
import { type SmsOperationsRouteServices } from "./handlers/operations.js";
import { type SmsResourceRouteServices } from "./handlers/resources.js";
export type SmsAdminRequestContext<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
    actor: Actor;
    trustedIp: string | undefined;
    requestId: string;
}>;
export type SmsAdminRoute = Readonly<{
    method: string;
    path: string;
}>;
export declare const smsAdminPermissions: readonly ["config.read", "config.write", "resource.sync", "signature.manage", "template.manage", "sms.test", "message.read", "stats.read", "receipt.reconcile"];
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
/**
 * The Task 2 router owns only trusted request context, exact route recognition,
 * and validation. Task-specific service dispatch is deliberately added by later
 * handlers, so no untrusted body field can become tenant or IP context here.
 */
export declare function createAdminRouter<Actor extends AuthorizationActor = AuthorizationActor>(options: SmsAdminHandlerOptions<Actor>): (request: Request) => Promise<Response>;
