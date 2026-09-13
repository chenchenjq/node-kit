export function isCloudApproved(status: string): boolean {
  return status.toLowerCase() === "approved" || status.toUpperCase() === "AUDIT_STATE_PASS";
}

/**
 * A template requires an enabled, cloud-approved signature at import time.
 * Preview applies this to current discovery with preserved local enablement
 * (new signatures default to enabled); commit applies it to the persisted row.
 * Signatures absent from complete discovery are retiring and cannot be selected.
 */
export function isUsableSignature(signature: Readonly<{ enabled: boolean; externalStatus: string }>): boolean {
  return signature.enabled && isCloudApproved(signature.externalStatus);
}
