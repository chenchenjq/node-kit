import type { Pool } from "pg";
import type { ConfigRepository, ProviderConfig, SmsTransaction, UpdateProviderConfigInput } from "../../ports/store.js";
import { type SafeEventMetadata } from "../../ports/runtime.js";
export declare class PgConfigRepository implements ConfigRepository {
    private readonly pool;
    constructor(pool: Pool);
    get(tx?: SmsTransaction): Promise<ProviderConfig>;
    update(input: UpdateProviderConfigInput, tx?: SmsTransaction): Promise<ProviderConfig>;
    recordConnectionTest(input: Readonly<{
        status: "succeeded" | "failed";
        summary: SafeEventMetadata;
        testedAt: Date;
        expectedVersion: number;
    }>, tx?: SmsTransaction): Promise<ProviderConfig>;
}
