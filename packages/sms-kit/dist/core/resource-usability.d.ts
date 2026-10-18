export declare function isCloudApproved(status: string): boolean;
/**
 * A template requires an enabled, cloud-approved signature at import time.
 * Preview applies this to current discovery with preserved local enablement
 * (new signatures default to enabled); commit applies it to the persisted row.
 * Signatures absent from complete discovery are retiring and cannot be selected.
 */
export declare function isUsableSignature(signature: Readonly<{
    enabled: boolean;
    externalStatus: string;
}>): boolean;
