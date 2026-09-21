/** Browser-safe public contracts. All timestamps are Unix milliseconds. */
export type CaptchaPurpose = "password-login" | "sms-login" | "password-reset";
export type SmsPurpose = "sms-login" | "password-reset";
export type AuthErrorCode = "INVALID_INPUT" | "INVALID_CREDENTIALS" | "CAPTCHA_INVALID" | "OTP_INVALID" | "RATE_LIMITED" | "UNAUTHENTICATED" | "FORBIDDEN" | "UNAVAILABLE" | "NOT_FOUND";
export type AuthFailure = {
    error: {
        code: AuthErrorCode;
        message: string;
    };
    retryAt?: number;
    serverTime: number;
};
export type Captcha = {
    id: string;
    image: string;
    expiresAt: number;
    serverTime: number;
};
export type CaptchaAnswer = {
    captchaId: string;
    captchaAnswer: string;
};
export type SendSmsInput = CaptchaAnswer & {
    phoneNumber: string;
    purpose: SmsPurpose;
};
export type SendSmsResult = {
    status: true;
    retryAt: number;
    serverTime: number;
};
export type PasswordLoginInput = CaptchaAnswer & {
    phoneNumber: string;
    password: string;
};
export type SmsLoginInput = {
    phoneNumber: string;
    code: string;
};
export type ResetPasswordInput = {
    phoneNumber: string;
    code: string;
    newPassword: string;
};
export type ChangePasswordInput = {
    currentPassword: string;
    newPassword: string;
};
export type AuthSession = {
    user: {
        id: string;
        name: string;
        phoneNumber: string;
    };
    expiresAt: string;
};
export type AuthSuccess = {
    status: true;
};
