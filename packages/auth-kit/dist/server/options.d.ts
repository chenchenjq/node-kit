import type { Pool } from "pg";
import type { SmsTransaction } from "sms-kit/ports";
import type { AuthSchema } from "./schema.js";
import type { RedisConnection } from "./state.js";
export type AuthKitSmsService = {
    issue(input: {
        subjectId: string;
        action: "login.authenticate" | "password.reset";
        phone: string;
        ipAddress?: string;
        idempotencyKey: string;
    }): Promise<{
        id: string;
        expiresAt: Date;
    }>;
    verifyAndConsume(input: {
        subjectId: string;
        action: "login.authenticate" | "password.reset";
        challengeId: string;
        code: string;
        consumptionKey: string;
    }, transaction: SmsTransaction): Promise<boolean>;
};
export type AuthKitOptions = {
    appId: string;
    /** Public origin, including https in production; never an internal proxy origin. */
    baseURL: string;
    basePath?: string;
    /** Explicit private-network HTTP origins; rejected when NODE_ENV=production. */
    developmentOrigins?: readonly string[];
    secret: string;
    pool: Pool;
    schema: AuthSchema;
    redis: RedisConnection;
    sms: {
        service: AuthKitSmsService;
    };
    /** Derive from trusted infrastructure, not arbitrary incoming forwarded headers. */
    resolveClientIp(request: Request): string | Promise<string>;
    /** Resolve an exact, unique host username to an existing auth user ID. Never create users. */
    resolveUsername?(username: string): Promise<string | null>;
    isUserAllowed?(user: {
        id: string;
        phoneNumber: string | null;
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
