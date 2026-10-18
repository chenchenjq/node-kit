import type { Pool } from "pg";
/** Explicit maintenance-window migration. Never invoked by createAuthKit. */
export declare function migrateAuthPhoneStorage(pool: Pool, namespace?: string): Promise<number>;
