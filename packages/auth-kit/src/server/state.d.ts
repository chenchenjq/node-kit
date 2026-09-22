import type { CaptchaPurpose } from "../types.js";
/** Host owns connection, TLS, timeouts and lifecycle. ioredis satisfies this port. */
export interface RedisConnection {
    eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}
export declare class SecurityState {
    private readonly redis;
    private readonly appId;
    private readonly secret;
    constructor(redis: RedisConnection, appId: string, secret: string);
    key(scope: string, value: string): string;
    now(): Promise<number>;
    limit(scope: string, value: string, now: number, window: number, limit: number, interval?: number, pending?: boolean): Promise<{
        allowed: boolean;
        retryAt: number;
    }>;
    reserveSend(phone: string, now: number, pending?: boolean): Promise<{
        allowed: boolean;
        retryAt: number;
    }>;
    /** Conservative completion-time fence: provider/database latency cannot shorten the next cooldown. */
    finishSend(phone: string, now: number): Promise<number>;
    clearDelivery(identifier: string): Promise<void>;
    acceptDelivery(identifier: string, expiresAt: number): Promise<void>;
    /** Stores only native issuance expiry, never SMS code/answer/hash or verification attempt counts. */
    deliveryAccepted(identifier: string, expiresAt: number): Promise<boolean>;
    saveCaptcha(context: string, purpose: CaptchaPurpose, id: string, answer: string, now: number): Promise<void>;
    consumeCaptcha(context: string, purpose: CaptchaPurpose, id: string, answer: string, now: number): Promise<boolean>;
}
