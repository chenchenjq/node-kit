import type { Pool } from "pg";
export declare function migrateSmsKit(pool: Pool): Promise<void>;
export declare function getSmsKitSchemaVersion(pool: Pool): Promise<number>;
