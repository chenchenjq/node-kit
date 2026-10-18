import type { ResourceSyncService } from "../../application/resource-sync-service.js";
import type { ResourceAdminService } from "../../application/resource-admin-service.js";
import type { AuthorizationActor } from "../../ports/security.js";
import type { Signature, Template } from "../../ports/store.js";
/** The built-in service owns authorization and durable mutation semantics. */
export type SmsResourceAdminService<Actor extends AuthorizationActor = AuthorizationActor> = Pick<ResourceAdminService<Actor>, "listSignatures" | "updateSignature" | "listTemplates" | "importTemplate" | "updateTemplate">;
export type SmsResourceRouteServices<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
    resourceSync?: Pick<ResourceSyncService<Actor>, "preview" | "commit">;
    resources?: SmsResourceAdminService<Actor>;
}>;
export declare function signatureDto(value: Signature): {
    id: string;
    externalKey: string;
    externalName: string;
    externalStatus: string;
    externalType: string;
    enabled: boolean;
    version: number;
};
export declare function templateDto(value: Template): {
    id: string;
    signatureId: string;
    templateKey: string;
    externalCode: string;
    externalName: string;
    externalStatus: string;
    templateType: "notification" | "verification";
    purpose: string;
    variables: {
        name: string;
        sensitive: boolean;
    }[];
    enabled: boolean;
    version: number;
};
export declare function resourceRoute<Actor extends AuthorizationActor>(services: SmsResourceRouteServices<Actor>, actor: Actor, path: string, body: unknown, params: Readonly<Record<string, string>>, query: Readonly<Record<string, unknown>>): Promise<unknown | undefined>;
