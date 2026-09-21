import "./server-only.js";

export { createAdminRouter as createSmsAdminHandler } from "./admin-router.js";
export { createAliyunReceiptHandler } from "./receipt-handler.js";
export type { AliyunReceiptHandlerOptions, AliyunReceiptIngestor } from "./receipt-handler.js";
export { createSmsTaskHandler, smsScheduledTaskNames } from "./task-handler.js";
export type { SmsScheduledTask, SmsScheduledTaskName, SmsTaskHandlerOptions } from "./task-handler.js";
export type { SmsConfigRouteServices } from "./handlers/config.js";
export type { BetterAuthVerificationSettingsSource, OperationJobAuthorization, SmsOperationsRouteServices } from "./handlers/operations.js";
export type { SmsResourceAdminService, SmsResourceRouteServices } from "./handlers/resources.js";
export type {
  SmsAdminDeferredAuthorization,
  SmsAdminCsrfProtection,
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
