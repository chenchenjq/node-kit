import type { BetterAuthOptions } from "better-auth";
import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { PoolClient } from "pg";
import type { AuthSchema } from "./schema.js";
/** Password writes and server-side session revocation commit together, including failures. */
export declare function credentialAdapter(client: PoolClient, schema: AuthSchema): (options: BetterAuthOptions) => DBAdapter;
