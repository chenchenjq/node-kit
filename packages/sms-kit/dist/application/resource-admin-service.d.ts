import type { Clock, EventSink, IdGenerator } from "../ports/runtime.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import type { Signature, SmsStore, Template } from "../ports/store.js";
export type ResourceAdminServiceDependencies<Actor extends Readonly<{
    id: string;
}> = AuthorizationActor> = Readonly<{
    store: SmsStore;
    authorizer: Authorizer<Actor>;
    clock: Clock;
    ids: Pick<IdGenerator, "next">;
    events: EventSink;
}>;
export type ResourceAdminUpdateSignatureInput = Readonly<{
    id: string;
    version: number;
    idempotencyKey: string;
    enabled: boolean;
}>;
export type ResourceAdminImportTemplateInput = Readonly<{
    version: number;
    idempotencyKey: string;
    candidateId: string;
    checksum: string;
    templateKey: string;
    purpose: string;
    signatureExternalKey: string;
}>;
export type ResourceAdminUpdateTemplateInput = Readonly<{
    id: string;
    version: number;
    idempotencyKey: string;
    templateKey?: string;
    enabled?: boolean;
    purpose?: string;
}>;
/** Owns all administrator reads/writes for the system-global signature/template catalog. */
export declare class ResourceAdminService<Actor extends Readonly<{
    id: string;
}> = AuthorizationActor> {
    private readonly dependencies;
    constructor(dependencies: ResourceAdminServiceDependencies<Actor>);
    listSignatures(actor: Actor, input: Readonly<{
        page: number;
        pageSize: number;
    }>): Promise<{
        items: readonly Signature[];
        total: number;
    }>;
    listTemplates(actor: Actor, input: Readonly<{
        page: number;
        pageSize: number;
    }>): Promise<{
        items: readonly Template[];
        total: number;
    }>;
    updateSignature(actor: Actor, input: ResourceAdminUpdateSignatureInput): Promise<Signature>;
    importTemplate(actor: Actor, input: ResourceAdminImportTemplateInput): Promise<Template>;
    updateTemplate(actor: Actor, input: ResourceAdminUpdateTemplateInput): Promise<Template>;
    private audit;
    private emit;
}
