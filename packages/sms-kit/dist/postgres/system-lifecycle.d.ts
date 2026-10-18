import type { Pool } from "pg";
import type { PhoneNumberProtector, SmsProvider } from "../ports/index.js";
export declare class PgSystemSmsLifecycle {
    private readonly deps;
    constructor(deps: {
        pool: Pool;
        provider: SmsProvider;
        phoneProtector: PhoneNumberProtector;
        config: {
            get(): Promise<{
                status: string;
                enabled: boolean;
                region?: string;
                endpoint?: string;
                accessKeyIdRef?: string;
                accessKeySecretRef?: string;
            }>;
        };
    });
    private transaction;
    recover(now?: Date): Promise<number>;
    private record;
    ingest(input: {
        body: string | Uint8Array;
        deadlineAt: Date;
        signal?: AbortSignal;
    }): Promise<{
        acknowledgement: {
            code: number;
            msg: string;
        };
    }>;
    reconcile(now?: Date): Promise<number>;
}
