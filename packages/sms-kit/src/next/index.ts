import "./server-only.js";

export { createAdminRouter as createSmsAdminHandler } from "./admin-router.js";
export type { SmsConfigRouteServices } from "./handlers/config.js";
export type { OperationJobAuthorization, SmsOperationsRouteServices } from "./handlers/operations.js";
export type { SmsResourceAdminService, SmsResourceRouteServices } from "./handlers/resources.js";
export type {
  SmsAdminDeferredAuthorization,
  SmsAdminDispatchInput,
  SmsAdminDispatchResult,
  SmsAdminAuthorizer,
  SmsAdminHandlerOptions,
  SmsAdminJobReadPermission,
  SmsAdminJobAuthorizationInput,
  SmsAdminPermission,
  SmsAdminRequestContext,
  SmsAdminRoute,
  SmsAdminServices,
} from "./admin-router.js";
