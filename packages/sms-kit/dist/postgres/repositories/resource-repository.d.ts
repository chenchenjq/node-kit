import type { Pool } from "pg";
import type { ImportTemplateResourceInput, ResourceRepository, ResourceSyncCandidate, ResourceSyncPreview, Signature, SmsTransaction, Template, UpdateSignatureResourceInput, UpdateTemplateResourceInput } from "../../ports/store.js";
export declare class PgResourceRepository implements ResourceRepository {
    private readonly pool;
    constructor(pool: Pool);
    findSignatureById(input: Readonly<{
        id: string;
    }>, tx?: SmsTransaction): Promise<Signature | undefined>;
    listSignatures(input: Readonly<{
        page: number;
        pageSize: number;
    }>, tx?: SmsTransaction): Promise<{
        items: readonly Signature[];
        total: number;
    }>;
    listTemplates(input: Readonly<{
        page: number;
        pageSize: number;
    }>, tx?: SmsTransaction): Promise<{
        items: readonly Template[];
        total: number;
    }>;
    findTemplateByKey(input: Readonly<{
        templateKey: string;
    }>, tx?: SmsTransaction): Promise<Template | undefined>;
    updateSignature(input: UpdateSignatureResourceInput, tx: SmsTransaction): Promise<Signature>;
    importTemplate(input: ImportTemplateResourceInput, tx: SmsTransaction): Promise<Template>;
    updateTemplate(input: UpdateTemplateResourceInput, tx: SmsTransaction): Promise<Template>;
    createSyncPreview(input: Readonly<{
        id: string;
        actorId: string;
        expiresAt: Date;
        resources: readonly ResourceSyncCandidate[];
    }>, tx?: SmsTransaction): Promise<ResourceSyncPreview>;
    commitSync(input: Readonly<{
        syncId: string;
        candidates: readonly Readonly<{
            id: string;
            checksum: string;
        }>[];
        now?: Date;
    }>, tx?: SmsTransaction): Promise<ResourceSyncPreview>;
}
