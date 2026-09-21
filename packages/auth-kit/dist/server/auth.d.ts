import type { AuthSession } from "../types.js";
import type { AuthKitOptions } from "./options.js";
export type AuthKit = {
    handler(request: Request): Promise<Response>;
    getSession(request: Request): Promise<AuthSession | null>;
};
export declare function createAuthKit(options: AuthKitOptions): AuthKit;
