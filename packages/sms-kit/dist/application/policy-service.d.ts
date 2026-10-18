import type { VerificationPolicy, VerificationPolicyUpdate } from "../ports/policy.js";
import type { Authorizer, AuthorizationActor } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";
import type { Clock, IdGenerator } from "../ports/runtime.js";
export type PolicyServiceDependencies<Actor extends AuthorizationActor = AuthorizationActor> = Readonly<{
    store: SmsStore;
    authorizer: Authorizer<Actor>;
    clock: Clock;
    ids: Pick<IdGenerator, "next">;
}>;
/** Public admin writes retain a policy-specific version and durable replay key. */
export type PatchVerificationPolicyInput = VerificationPolicyUpdate & Readonly<{
    idempotencyKey: string;
}>;
/** Validates policy separately from provider configuration and its readiness version. */
export declare function validateVerificationPolicy(input: VerificationPolicyUpdate): void;
export declare class PolicyService<Actor extends AuthorizationActor = AuthorizationActor> {
    private readonly dependencies;
    constructor(dependencies: PolicyServiceDependencies<Actor>);
    get(actor: Actor): Promise<VerificationPolicy>;
    update(actor: Actor, input: VerificationPolicyUpdate): Promise<VerificationPolicy>;
    /**
     * Applies an admin policy patch with tenant-scoped durable replay.  The
     * policy row itself remains global and keeps its own optimistic version;
     * provider configuration is intentionally never read or saved here.
     */
    patch(actor: Actor, input: PatchVerificationPolicyInput): Promise<VerificationPolicy>;
    private updateInTransaction;
}
