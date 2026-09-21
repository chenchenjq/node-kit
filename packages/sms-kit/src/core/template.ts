import { SmsKitError } from "./errors.js";

const templateKeyPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function validateTemplateKey(key: string): void {
  if (!templateKeyPattern.test(key)) {
    throw new SmsKitError("TEMPLATE_UNAVAILABLE", `invalid template key: ${key}`);
  }
}

export function validateTemplateVariables(
  declared: readonly string[],
  values: Readonly<Record<string, string>>,
): void {
  const missing = declared.filter((name) => !Object.prototype.hasOwnProperty.call(values, name));
  const unexpected = Object.keys(values).filter((name) => !declared.includes(name));
  if (missing.length || unexpected.length) {
    throw new SmsKitError(
      "TEMPLATE_VARIABLE_INVALID",
      [
        ...missing.map((name) => `missing variable: ${name}`),
        ...unexpected.map((name) => `unexpected variable: ${name}`),
      ].join(", "),
    );
  }
}
