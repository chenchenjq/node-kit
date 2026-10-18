import type { CreateMessageInput } from "../ports/store.js";
import type { MessageId, TemplateId, TenantId } from "../core/types.js";
/** A deterministic clock for tests; production code must receive time explicitly. */
export declare class FakeClock {
    private value;
    constructor(now: Date);
    now(): Date;
    advance(milliseconds: number): Date;
}
/** Deterministic non-secret identifiers for test-only idempotency and dedupe keys. */
export declare class SequenceIdGenerator {
    private readonly prefix;
    private sequence;
    constructor(prefix?: string);
    next(): string;
}
/** Builds a persistence-safe message fixture: it contains no plaintext phone or render values. */
export declare function createSafeMessageFixture(input: Readonly<{
    id: MessageId;
    tenantId: TenantId;
    templateId: TemplateId;
    idempotencyKey: string;
    submittedAt: Date;
}>): CreateMessageInput;
