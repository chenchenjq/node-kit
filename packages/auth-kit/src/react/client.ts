import type {
  AuthErrorCode,
  AuthFailure,
  AuthSession,
  AuthSuccess,
  Captcha,
  CaptchaPurpose,
  ChangePasswordInput,
  PasswordLoginInput,
  ResetPasswordInput,
  SendSmsInput,
  SendSmsResult,
  SmsLoginInput,
} from "../types.js";

export class AuthClientError extends Error {
  readonly code: AuthErrorCode;
  readonly retryAt?: number;
  readonly serverTime: number;
  readonly failure: AuthFailure;

  constructor(failure: AuthFailure) {
    super(failure.error.message);
    this.name = "AuthClientError";
    this.code = failure.error.code;
    this.serverTime = failure.serverTime;
    this.failure = failure;
    if (failure.retryAt !== undefined) {
      this.retryAt = failure.retryAt;
    }
  }
}

const errorCodes = new Set<string>([
  "INVALID_INPUT",
  "INVALID_CREDENTIALS",
  "CAPTCHA_INVALID",
  "OTP_INVALID",
  "RATE_LIMITED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "UNAVAILABLE",
  "NOT_FOUND",
]);

function isAuthFailure(value: unknown): value is AuthFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.serverTime === "number" &&
    typeof candidate.error === "object" &&
    candidate.error !== null &&
    typeof (candidate.error as Record<string, unknown>).message === "string" &&
    typeof (candidate.error as Record<string, unknown>).code === "string" &&
    errorCodes.has(
      (candidate.error as Record<string, unknown>).code as string
    ) &&
    (candidate.retryAt === undefined || typeof candidate.retryAt === "number")
  );
}

function unavailable(message = "认证服务暂时不可用"): AuthClientError {
  return new AuthClientError({
    error: { code: "UNAVAILABLE", message },
    serverTime: Date.now(),
  });
}

export type AuthClientOptions = {
  basePath?: string;
  fetch?: typeof fetch;
};

export type AuthClient = {
  captcha(purpose: CaptchaPurpose): Promise<Captcha>;
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
  signInPassword(input: PasswordLoginInput): Promise<AuthSuccess>;
  signInSms(input: SmsLoginInput): Promise<AuthSuccess>;
  resetPassword(input: ResetPasswordInput): Promise<AuthSuccess>;
  changePassword(input: ChangePasswordInput): Promise<AuthSuccess>;
  signOut(): Promise<AuthSuccess>;
  getSession(): Promise<AuthSession>;
};

export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const basePath = options.basePath?.replace(/\/+$/, "") || "/api/auth-kit";
  const requestFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);

  async function request<T>(
    path: string,
    method: string,
    body?: unknown
  ): Promise<T> {
    if (requestFetch === undefined) throw unavailable();
    let response: Response;
    try {
      response = await requestFetch(`${basePath}${path}`, {
        method,
        credentials: "same-origin",
        headers:
          body === undefined
            ? { accept: "application/json" }
            : {
                accept: "application/json",
                "content-type": "application/json",
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (error instanceof AuthClientError) throw error;
      throw unavailable();
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw unavailable();
    }

    if (!response.ok) {
      if (isAuthFailure(payload)) throw new AuthClientError(payload);
      throw unavailable();
    }
    return payload as T;
  }

  return {
    captcha: (purpose) => request("/captcha", "POST", { purpose }),
    sendSms: (input) => request("/sms/send", "POST", input),
    signInPassword: (input) => request("/sign-in/password", "POST", input),
    signInSms: (input) => request("/sign-in/sms", "POST", input),
    resetPassword: (input) => request("/password/reset", "POST", input),
    changePassword: (input) => request("/password/change", "POST", input),
    signOut: () => request("/sign-out", "POST", {}),
    getSession: () => request("/session", "GET"),
  };
}

