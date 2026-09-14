import "./server-only.js";

export { createAdminRouter as createSmsAdminHandler } from "./admin-router.js";
export type { SmsAdminHandlerOptions, SmsAdminRequestContext, SmsAdminServices } from "./admin-router.js";
