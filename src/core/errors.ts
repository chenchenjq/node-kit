export type SmsErrorCode =
  | "CONFIG_INVALID"
  | "SECRET_UNRESOLVABLE"
  | "PERMISSION_DENIED"
  | "SIGNATURE_UNAVAILABLE"
  | "TEMPLATE_UNAVAILABLE"
  | "TEMPLATE_VARIABLE_INVALID"
  | "RATE_LIMITED"
  | "BUDGET_EXCEEDED"
  | "CIRCUIT_OPEN"
  | "PROVIDER_REJECTED"
  | "PROVIDER_THROTTLED"
  | "PROVIDER_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "CONCURRENT_MODIFICATION"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_ATTEMPTS_EXCEEDED"
  | "PROOF_INVALID"
  | "ACCEPTANCE_UNKNOWN"
  | "DELIVERY_UNKNOWN"
  | "STORAGE_FAILURE";

export type SmsFieldErrors = Readonly<Record<string, readonly string[]>>;

function toImmutableFieldErrors(fieldErrors: SmsFieldErrors): SmsFieldErrors {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(fieldErrors).map(([field, messages]) => [field, Object.freeze([...messages])]),
    ),
  );
}

export class SmsKitError extends Error {
  readonly code: SmsErrorCode;
  readonly retryable: boolean;
  readonly fieldErrors?: SmsFieldErrors;
  readonly causeCode?: string;

  constructor(
    code: SmsErrorCode,
    message: string,
    retryable = false,
    fieldErrors?: SmsFieldErrors,
    causeCode?: string,
  ) {
    super(message);
    this.name = "SmsKitError";
    this.code = code;
    this.retryable = retryable;
    if (fieldErrors !== undefined) {
      this.fieldErrors = toImmutableFieldErrors(fieldErrors);
    }
    if (causeCode !== undefined) {
      this.causeCode = causeCode;
    }
  }

  toJSON(): {
    code: SmsErrorCode;
    message: string;
    retryable: boolean;
    fieldErrors?: SmsFieldErrors;
    causeCode?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.fieldErrors === undefined ? {} : { fieldErrors: this.fieldErrors }),
      ...(this.causeCode === undefined ? {} : { causeCode: this.causeCode }),
    };
  }
}
