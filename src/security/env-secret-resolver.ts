import { SmsKitError } from "../core/errors.js";
import type { SecretResolver } from "../ports/security.js";

const ENV_REFERENCE = /^env:\/\/([A-Z_][A-Z0-9_]*)$/;
const UNRESOLVABLE_MESSAGE = "secret reference is unavailable";

/** Resolves explicit environment references without caching or emitting secret values. */
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>>) {}

  async resolve(reference: string): Promise<string> {
    const variableName = ENV_REFERENCE.exec(reference)?.[1];
    if (variableName === undefined) {
      throw new SmsKitError("SECRET_UNRESOLVABLE", UNRESOLVABLE_MESSAGE);
    }

    const value = this.environment[variableName];
    if (value === undefined || value.trim().length === 0) {
      throw new SmsKitError("SECRET_UNRESOLVABLE", UNRESOLVABLE_MESSAGE);
    }

    return value;
  }
}
