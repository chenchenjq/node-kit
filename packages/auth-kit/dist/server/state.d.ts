export type RedisConnection = {
    eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
};
export declare class SecurityState {
    readonly redis: RedisConnection;
    readonly appId: string;
    readonly secret: string;
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
    setActiveChallenge(subjectId: string, action: string, challengeId: string, ttlMs: number): Promise<void>;
    getActiveChallenge(subjectId: string, action: string): Promise<string | null>;
    clearActiveChallenge(subjectId: string, action: string): Promise<void>;
    clearDelivery(identifier: string): Promise<void>;
    acceptDelivery(identifier: string, expiresAt: number): Promise<void>;
    /** Stores only native issuance expiry, never SMS code/answer/hash or verification attempt counts. */
    deliveryAccepted(identifier: string, expiresAt: number): Promise<boolean>;
    saveCaptcha(context: string, purpose: string, id: string, answer: string, now: number): Promise<void>;
    consumeCaptcha(context: string, purpose: string, id: string, answer: string, now: number): Promise<boolean>;
}
