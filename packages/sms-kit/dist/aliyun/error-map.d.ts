import { SmsKitError } from "../core/errors.js";
export type AliyunFailureClass = {
    kind: "rejected";
    retryable: false;
    code: string;
} | {
    kind: "rejected";
    retryable: true;
    code: string;
} | {
    kind: "unknown";
    retryable: false;
    code: "ACCEPTANCE_UNKNOWN";
};
export declare function classifyAliyunFailure(error: unknown): AliyunFailureClass;
/**
 * Maps only the provider's machine-readable code. Provider messages often carry
 * request context, so they are deliberately never copied into application errors.
 */
export declare function classifyAliyunError(error: unknown): SmsKitError;
