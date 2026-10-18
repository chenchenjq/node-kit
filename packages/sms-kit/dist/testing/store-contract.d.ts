import type { MessageId, TenantId, TemplateId } from "../core/types.js";
import { type SmsStore } from "../ports/store.js";
import { FakeClock, SequenceIdGenerator } from "./fakes.js";
export type SmsStoreContractFactory = Readonly<{
    name?: string;
    tenantMode?: "multiple" | "fixed";
    createStore(): Promise<SmsStore>;
    clock: FakeClock;
    ids: SequenceIdGenerator;
    templateId(): TemplateId;
    tenantId(value: string): TenantId;
    messageId(): MessageId;
    createVerifiedProof(input: Readonly<{
        tenantId: TenantId;
        subjectId: string;
        action: string;
        proof: string;
        now: Date;
    }>): Promise<unknown>;
}>;
/**
 * Shared behavioral contract for a complete trusted-tenant SmsStore. Factories
 * provide only setup seams that no public Store port can express (a template
 * and an already verified proof).
 */
export declare function runSmsStoreContract(factory: SmsStoreContractFactory): void;
