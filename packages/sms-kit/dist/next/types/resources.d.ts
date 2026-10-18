import { z } from "zod";
export declare const resourceChangeTypeSchema: z.ZodEnum<{
    changed: "changed";
    new: "new";
    unavailable: "unavailable";
    unchanged: "unchanged";
}>;
export declare const resourceTypeSchema: z.ZodEnum<{
    signature: "signature";
    template: "template";
}>;
export declare const resourceCandidateDtoSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodString;
    externalKey: z.ZodString;
    changeType: z.ZodEnum<{
        changed: "changed";
        new: "new";
        unavailable: "unavailable";
        unchanged: "unchanged";
    }>;
    checksum: z.ZodString;
    expiresAt: z.ZodString;
    resourceType: z.ZodLiteral<"signature">;
    snapshot: z.ZodObject<{
        kind: z.ZodLiteral<"signature">;
        externalName: z.ZodString;
        externalStatus: z.ZodString;
        externalType: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    externalKey: z.ZodString;
    changeType: z.ZodEnum<{
        changed: "changed";
        new: "new";
        unavailable: "unavailable";
        unchanged: "unchanged";
    }>;
    checksum: z.ZodString;
    expiresAt: z.ZodString;
    resourceType: z.ZodLiteral<"template">;
    snapshot: z.ZodObject<{
        kind: z.ZodLiteral<"template">;
        externalName: z.ZodString;
        externalStatus: z.ZodString;
        templateType: z.ZodEnum<{
            notification: "notification";
            verification: "verification";
        }>;
        variableNames: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>], "resourceType">;
export declare const resourceSyncPreviewDtoSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<{
        failed: "failed";
        partial: "partial";
        running: "running";
        succeeded: "succeeded";
    }>;
    expiresAt: z.ZodString;
    candidates: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        externalKey: z.ZodString;
        changeType: z.ZodEnum<{
            changed: "changed";
            new: "new";
            unavailable: "unavailable";
            unchanged: "unchanged";
        }>;
        checksum: z.ZodString;
        expiresAt: z.ZodString;
        resourceType: z.ZodLiteral<"signature">;
        snapshot: z.ZodObject<{
            kind: z.ZodLiteral<"signature">;
            externalName: z.ZodString;
            externalStatus: z.ZodString;
            externalType: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        externalKey: z.ZodString;
        changeType: z.ZodEnum<{
            changed: "changed";
            new: "new";
            unavailable: "unavailable";
            unchanged: "unchanged";
        }>;
        checksum: z.ZodString;
        expiresAt: z.ZodString;
        resourceType: z.ZodLiteral<"template">;
        snapshot: z.ZodObject<{
            kind: z.ZodLiteral<"template">;
            externalName: z.ZodString;
            externalStatus: z.ZodString;
            templateType: z.ZodEnum<{
                notification: "notification";
                verification: "verification";
            }>;
            variableNames: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>], "resourceType">>;
}, z.core.$strict>;
export declare const resourceSyncPreviewInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    pageSize: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const resourceSyncCommitInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    syncId: z.ZodUUID;
    candidates: z.ZodArray<z.ZodObject<{
        id: z.ZodUUID;
        checksum: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const resourceSyncCommitResultDtoSchema: z.ZodObject<{
    id: z.ZodString;
    status: z.ZodEnum<{
        failed: "failed";
        partial: "partial";
        succeeded: "succeeded";
    }>;
    expiresAt: z.ZodString;
    importedCount: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    candidates: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        externalKey: z.ZodString;
        changeType: z.ZodEnum<{
            changed: "changed";
            new: "new";
            unavailable: "unavailable";
            unchanged: "unchanged";
        }>;
        checksum: z.ZodString;
        expiresAt: z.ZodString;
        resourceType: z.ZodLiteral<"signature">;
        snapshot: z.ZodObject<{
            kind: z.ZodLiteral<"signature">;
            externalName: z.ZodString;
            externalStatus: z.ZodString;
            externalType: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        externalKey: z.ZodString;
        changeType: z.ZodEnum<{
            changed: "changed";
            new: "new";
            unavailable: "unavailable";
            unchanged: "unchanged";
        }>;
        checksum: z.ZodString;
        expiresAt: z.ZodString;
        resourceType: z.ZodLiteral<"template">;
        snapshot: z.ZodObject<{
            kind: z.ZodLiteral<"template">;
            externalName: z.ZodString;
            externalStatus: z.ZodString;
            templateType: z.ZodEnum<{
                notification: "notification";
                verification: "verification";
            }>;
            variableNames: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>], "resourceType">>;
}, z.core.$strict>;
export declare const signatureDtoSchema: z.ZodObject<{
    id: z.ZodString;
    externalKey: z.ZodString;
    externalName: z.ZodString;
    externalStatus: z.ZodString;
    externalType: z.ZodString;
    enabled: z.ZodBoolean;
    version: z.ZodNumber;
}, z.core.$strict>;
export declare const updateSignatureInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    enabled: z.ZodBoolean;
}, z.core.$strict>;
export declare const templateVariableDtoSchema: z.ZodObject<{
    name: z.ZodString;
    sensitive: z.ZodBoolean;
}, z.core.$strict>;
export declare const templateDtoSchema: z.ZodObject<{
    id: z.ZodString;
    signatureId: z.ZodString;
    templateKey: z.ZodString;
    externalCode: z.ZodString;
    externalName: z.ZodString;
    externalStatus: z.ZodString;
    templateType: z.ZodEnum<{
        notification: "notification";
        verification: "verification";
    }>;
    purpose: z.ZodString;
    variables: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        sensitive: z.ZodBoolean;
    }, z.core.$strict>>;
    enabled: z.ZodBoolean;
    version: z.ZodNumber;
}, z.core.$strict>;
export declare const importTemplateInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    candidateId: z.ZodUUID;
    checksum: z.ZodString;
    templateKey: z.ZodString;
    purpose: z.ZodString;
    signatureExternalKey: z.ZodString;
}, z.core.$strict>;
export declare const updateTemplateInputSchema: z.ZodObject<{
    version: z.ZodNumber;
    idempotencyKey: z.ZodString;
    templateKey: z.ZodOptional<z.ZodString>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    purpose: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const signaturePageDtoSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        externalKey: z.ZodString;
        externalName: z.ZodString;
        externalStatus: z.ZodString;
        externalType: z.ZodString;
        enabled: z.ZodBoolean;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    page: z.ZodNumber;
    pageSize: z.ZodNumber;
    total: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
}, z.core.$strict>;
export declare const templatePageDtoSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        signatureId: z.ZodString;
        templateKey: z.ZodString;
        externalCode: z.ZodString;
        externalName: z.ZodString;
        externalStatus: z.ZodString;
        templateType: z.ZodEnum<{
            notification: "notification";
            verification: "verification";
        }>;
        purpose: z.ZodString;
        variables: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            sensitive: z.ZodBoolean;
        }, z.core.$strict>>;
        enabled: z.ZodBoolean;
        version: z.ZodNumber;
    }, z.core.$strict>>;
    page: z.ZodNumber;
    pageSize: z.ZodNumber;
    total: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
}, z.core.$strict>;
export type ResourceCandidateDto = z.infer<typeof resourceCandidateDtoSchema>;
export type ResourceSyncPreviewDto = z.infer<typeof resourceSyncPreviewDtoSchema>;
export type ResourceSyncPreviewInput = z.infer<typeof resourceSyncPreviewInputSchema>;
export type ResourceSyncCommitInput = z.infer<typeof resourceSyncCommitInputSchema>;
export type ResourceSyncCommitResultDto = z.infer<typeof resourceSyncCommitResultDtoSchema>;
export type SignatureDto = z.infer<typeof signatureDtoSchema>;
export type UpdateSignatureInput = z.infer<typeof updateSignatureInputSchema>;
export type TemplateVariableDto = z.infer<typeof templateVariableDtoSchema>;
export type TemplateDto = z.infer<typeof templateDtoSchema>;
export type ImportTemplateInput = z.infer<typeof importTemplateInputSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateInputSchema>;
