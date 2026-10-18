import { type SmsProvider } from "../ports/provider.js";
import type { Clock } from "../ports/runtime.js";
import type { MessagePayloadProtector, PhoneNumberProtector } from "../ports/security.js";
import type { SmsStore } from "../ports/store.js";
export type SendWorkerDependencies = Readonly<{
    store: SmsStore;
    provider: SmsProvider;
    phoneProtector: PhoneNumberProtector;
    payloadProtector: MessagePayloadProtector;
    clock: Clock;
}>;
export type SendWorkerRunInput = Readonly<{
    workerId: string;
    limit: number;
    leaseMs: number;
    providerTimeoutMs: number;
}>;
/**
 * Executes notification and authorized test jobs after a durable attempt marker has fenced the
 * current job lease. The marker is deliberately committed before any secret is
 * opened or provider request begins, so a process loss is conservative.
 */
export declare class SendWorker {
    private readonly dependencies;
    constructor(dependencies: SendWorkerDependencies);
    runBatch(input: SendWorkerRunInput): Promise<number>;
    private runJob;
    private openProviderInput;
    private complete;
}
