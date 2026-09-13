import { parsePhoneNumberFromString } from "libphonenumber-js/max";

import { SmsKitError } from "./errors.js";

export type MainlandPhone = string & { readonly __brand: "MainlandPhone" };

export function normalizeMainlandPhone(input: string): MainlandPhone {
  const parsed = parsePhoneNumberFromString(input, "CN");
  const nationalNumber = parsed?.nationalNumber;

  if (
    parsed === undefined ||
    parsed.country !== "CN" ||
    !parsed.isValid() ||
    (parsed.getType() !== "MOBILE" && parsed.getType() !== "FIXED_LINE_OR_MOBILE") ||
    nationalNumber === undefined ||
    !/^1[3-9]\d{9}$/.test(nationalNumber)
  ) {
    throw new SmsKitError("CONFIG_INVALID", "phone number must be valid for mainland China");
  }

  return parsed.number as MainlandPhone;
}

export function maskMainlandPhone(phone: MainlandPhone): string {
  const nationalNumber = phone.slice(3);
  return `${nationalNumber.slice(0, 3)}****${nationalNumber.slice(-4)}`;
}
