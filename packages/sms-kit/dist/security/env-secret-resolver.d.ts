import type { SecretResolver } from "../ports/security.js";
/** Resolves explicit environment references without caching or emitting secret values. */
export declare class EnvSecretResolver implements SecretResolver {
    private readonly environment;
    constructor(environment: Readonly<Record<string, string | undefined>>);
    resolve(reference: string): Promise<string>;
}
