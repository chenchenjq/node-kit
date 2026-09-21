import type { Pool } from "pg";
import type { SendService } from "sms-kit/application";
import type { TenantId } from "sms-kit/core";
import type { AuthSchema } from "./schema.js";
import type { RedisConnection } from "./state.js";
export type AuthKitOptions = {
    appId: string;
    /** Public origin, including https in production; never an internal proxy origin. */
    baseURL: string;
    basePath?: string;
    secret: string;
    pool: Pool;
    schema: AuthSchema;
    redis: RedisConnection;
    sms: {
        sendService: Pick<SendService, "sendOtpNow">;
        tenantId: TenantId;
        templates?: {
            login?: string;
            passwordReset?: string;
        };
    };
    /** Derive from trusted infrastructure, not arbitrary incoming forwarded headers. */
    resolveClientIp(request: Request): string | Promise<string>;
    isUserAllowed?(user: {
        id: string;
        phoneNumber: string;
        enabled: boolean;
    }): boolean | Promise<boolean>;
    /** Only needed for legacy pepper/pre-processing. New hashes are always Argon2id. */
    verifyLegacyPassword?(input: {
        hash: string;
        password: string;
    }): Promise<boolean>;
    /** Reserved, no provider, route, QR code or UI is enabled. */
    wechat?: {
        enabled?: false;
    };
};
