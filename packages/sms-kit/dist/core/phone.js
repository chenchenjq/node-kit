import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { SmsKitError } from "./errors.js";
/** Strict national storage representation; E.164 remains the provider/lookup contract. */
export function normalizeMainlandNationalPhone(input) {
    const value = input.trim().replace(/[ -]/g, "");
    if (!/^(?:(?:\+86|\+086|0086))?1[3-9]\d{9}$/.test(value)) {
        throw new SmsKitError("CONFIG_INVALID", "phone number must be valid for mainland China");
    }
    return normalizeMainlandPhone(value.replace(/^\+086/, "+86")).slice(3);
}
export function normalizeMainlandPhone(input) {
    const parsed = parsePhoneNumberFromString(input, "CN");
    const nationalNumber = parsed?.nationalNumber;
    if (parsed === undefined ||
        parsed.country !== "CN" ||
        !parsed.isValid() ||
        (parsed.getType() !== "MOBILE" && parsed.getType() !== "FIXED_LINE_OR_MOBILE") ||
        nationalNumber === undefined ||
        !/^1[3-9]\d{9}$/.test(nationalNumber)) {
        throw new SmsKitError("CONFIG_INVALID", "phone number must be valid for mainland China");
    }
    return parsed.number;
}
export function maskMainlandPhone(phone) {
    const nationalNumber = phone.slice(3);
    return `${nationalNumber.slice(0, 3)}****${nationalNumber.slice(-4)}`;
}
