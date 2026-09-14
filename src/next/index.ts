import "./server-only.js";

export { createAdminRouter as createSmsAdminHandler } from "./admin-router.js";
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
