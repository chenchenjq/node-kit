import type { AuthErrorCode, AuthFailure, AuthSession, AuthSuccess, Captcha, CaptchaPurpose, ChangePasswordInput, PasswordLoginInput, ResetPasswordInput, SendSmsInput, SendSmsResult, SmsLoginInput } from "../types.js";
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
export declare class AuthClientError extends Error {
    readonly code: AuthErrorCode;
    readonly retryAt?: number;
    readonly serverTime: number;
    readonly failure: AuthFailure;
    constructor(failure: AuthFailure);
}
export declare function createAuthClient(options?: AuthClientOptions): AuthClient;
