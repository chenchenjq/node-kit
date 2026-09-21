const messages = {
    INVALID_INPUT: "请检查输入内容",
    INVALID_CREDENTIALS: "手机号或密码错误，或当前无法登录",
    CAPTCHA_INVALID: "图形验证码无效，请刷新后重试",
    OTP_INVALID: "短信验证码无效或已过期",
    RATE_LIMITED: "操作频繁，请稍后重试",
    UNAUTHENTICATED: "请重新登录",
    FORBIDDEN: "请求不被允许",
    UNAVAILABLE: "服务暂时不可用，请稍后重试",
    NOT_FOUND: "接口不存在",
};
export class AuthKitError extends Error {
    code;
    status;
    retryAt;
    constructor(code, status, retryAt) {
        super(messages[code]);
        this.code = code;
        this.status = status;
        this.retryAt = retryAt;
    }
}
export function errorResponse(error, serverTime = Date.now()) {
    const safe = error instanceof AuthKitError
        ? error
        : new AuthKitError("UNAVAILABLE", 503);
    const body = {
        error: { code: safe.code, message: safe.message },
        serverTime,
        ...(safe.retryAt === undefined ? {} : { retryAt: safe.retryAt }),
    };
    const headers = { "cache-control": "no-store" };
    if (safe.retryAt !== undefined)
        headers["retry-after"] = String(Math.max(1, Math.ceil((safe.retryAt - serverTime) / 1000)));
    return Response.json(body, { status: safe.status, headers });
}
