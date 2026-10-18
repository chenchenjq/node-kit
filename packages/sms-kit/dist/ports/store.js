import { SmsKitError } from "../core/errors.js";
import { validateTemplateKey } from "../core/template.js";
export function hasTemplateResourceSelection(candidate) {
    return candidate.resourceType === "template" &&
        typeof candidate.signatureExternalKey === "string" &&
        typeof candidate.templateKey === "string" &&
        typeof candidate.purpose === "string";
}
function invalidResourceSyncCandidate() {
    throw new SmsKitError("CONFIG_INVALID", "invalid resource sync preview");
}
function requireObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return invalidResourceSyncCandidate();
    }
    return value;
}
function requireString(source, key) {
    const value = Reflect.get(source, key);
    if (typeof value !== "string")
        return invalidResourceSyncCandidate();
    return value;
}
function requireEnum(source, key, allowed) {
    const value = Reflect.get(source, key);
    if (typeof value !== "string" || !allowed.includes(value))
        return invalidResourceSyncCandidate();
    return value;
}
function requireStringArray(source, key) {
    const value = Reflect.get(source, key);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        return invalidResourceSyncCandidate();
    }
    return Object.freeze([...value]);
}
function requireTemplateKey(source) {
    const value = requireString(source, "templateKey");
    try {
        validateTemplateKey(value);
    }
    catch {
        return invalidResourceSyncCandidate();
    }
    return value;
}
/**
 * Enforces the resource-preview persistence boundary. This copies only the
 * allowed provider fields, discarding every extra property from an untrusted
 * SDK response before an adapter can persist it.
 */
export function createResourceSyncCandidate(input) {
    const source = requireObject(input);
    const base = {
        id: requireString(source, "id"),
        externalKey: requireString(source, "externalKey"),
        changeType: requireEnum(source, "changeType", ["new", "changed", "unavailable", "unchanged"]),
        checksum: requireString(source, "checksum"),
    };
    const resourceType = requireEnum(source, "resourceType", ["signature", "template"]);
    const sourceSnapshot = requireObject(Reflect.get(source, "snapshot"));
    if (resourceType === "signature") {
        if (requireEnum(sourceSnapshot, "kind", ["signature"]) !== "signature") {
            return invalidResourceSyncCandidate();
        }
        const snapshot = Object.freeze({
            kind: "signature",
            externalName: requireString(sourceSnapshot, "externalName"),
            externalStatus: requireString(sourceSnapshot, "externalStatus"),
            externalType: requireString(sourceSnapshot, "externalType"),
        });
        return Object.freeze({ ...base, resourceType, snapshot });
    }
    if (requireEnum(sourceSnapshot, "kind", ["template"]) !== "template") {
        return invalidResourceSyncCandidate();
    }
    const snapshot = Object.freeze({
        kind: "template",
        externalCode: requireString(sourceSnapshot, "externalCode"),
        externalName: requireString(sourceSnapshot, "externalName"),
        externalStatus: requireString(sourceSnapshot, "externalStatus"),
        templateType: requireEnum(sourceSnapshot, "templateType", ["verification", "notification"]),
        variableNames: requireStringArray(sourceSnapshot, "variableNames"),
    });
    const hasSelection = ["signatureExternalKey", "templateKey", "purpose"]
        .some((key) => Reflect.get(source, key) !== undefined);
    if (!hasSelection) {
        return Object.freeze({ ...base, resourceType, snapshot });
    }
    return Object.freeze({
        ...base,
        resourceType,
        snapshot,
        signatureExternalKey: requireString(source, "signatureExternalKey"),
        templateKey: requireTemplateKey(source),
        purpose: requireString(source, "purpose"),
    });
}
