import { type TenantId } from "../core/types.js";
import type { PolicyStore } from "../ports/policy.js";
import { type SmsProvider } from "../ports/provider.js";
import type { Clock, EventSink, IdGenerator, TestRecipientAllowlist } from "../ports/runtime.js";
import type { AuthorizationActor, Authorizer, DeterministicRequestFingerprinter, MessagePayloadProtector, PhoneNumberProtector } from "../ports/security.js";
import type { AttemptRepository, Message, SmsStore } from "../ports/store.js";
export type SendInput = Readonly<{
    /** Supplied by a trusted host-authentication boundary; never copied from an HTTP body. */
    tenantId: TenantId;
    templateKey: string;
    phone: string;
    variables: Readonly<Record<string, string>>;
    purpose: string;
    idempotencyKey: string;
}>;
export type EnqueueNotificationInput = SendInput;
/**
 * A versioned administrative send is intentionally separate from ordinary
 * application sends: its recipient has a host-owned allowlist and its
 * idempotency result is durably replayed without accepting a second message.
 */
export type EnqueueTestNotificationInput = Readonly<{
    expectedVersion: number;
    idempotencyKey: string;
    templateKey: string;
    phone: string;
    variables: Readonly<Record<string, string>>;
    purpose: string;
}>;
export type TestNotificationMessage = Pick<Message, "id" | "phoneMasked" | "phoneLast4" | "templateKeySnapshot" | "purpose" | "acceptanceStatus" | "deliveryStatus" | "submittedAt" | "providerBizId" | "finalErrorCode">;
export type SendServiceDependencies = Readonly<{
    store: SmsStore;
    provider: SmsProvider;
    phoneProtector: PhoneNumberProtector;
    payloadProtector: MessagePayloadProtector;
    /** Optional overrides make this boundary usable with independently provisioned repositories. */
    policy?: PolicyStore;
    attempts?: AttemptRepository;
    clock: Clock;
    ids: IdGenerator;
    events: EventSink;
    providerTimeoutMs: number;
    /** Required only for /config/test-send; absent configuration fails closed. */
    testRecipientAllowlist?: TestRecipientAllowlist;
    /** Required only for /config/test-send so direct application calls cannot bypass sms.test. */
    testAuthorizer?: Authorizer<AuthorizationActor>;
    /** Deterministic keyed host fingerprint used to avoid persisting test phone/variable inputs. */
    testRequestFingerprinter?: DeterministicRequestFingerprinter;
}>;
/** Persists safe send state before external dispatch; acceptance and delivery deliberately remain distinct. */
export declare class SendService {
    private readonly dependencies;
    constructor(dependencies: SendServiceDependencies);
    enqueueNotification(input: EnqueueNotificationInput): Promise<Message>;
    /**
     * Queues one host-allowlisted administrative message through the normal
     * message/job pipeline. Its durable operation record prevents retries from
     * creating another job, while the snapshot deliberately contains only the
     * same safe fields returned by the admin DTO.
     */
    enqueueTestNotification(actor: AuthorizationActor, input: EnqueueTestNotificationInput): Promise<TestNotificationMessage>;
    sendOtpNow(input: SendInput): Promise<Message>;
    private requireUsableTemplate;
    private complete;
}
