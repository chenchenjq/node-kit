export { createAuthKit, type AuthKit } from "./auth.js";
export { migrateAuthPhoneStorage } from "./phone-migration.js";
export {
  hashPassword,
  verifyPassword,
  validatePassword,
} from "./password.js";
export { AuthKitError } from "./errors.js";
export type { AuthKitOptions } from "./options.js";
export type { AuthSchema } from "./schema.js";
export type { RedisConnection } from "./state.js";

