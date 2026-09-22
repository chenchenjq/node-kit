export class AuthClientError extends Error {
    code;
    retryAt;
    serverTime;
    failure;
    constructor(failure) {
        super(failure.error.message);
        this.name = "AuthClientError";
        this.code = failure.error.code;
        this.serverTime = failure.serverTime;
        this.failure = failure;
        if (failure.retryAt !== undefined)
            this.retryAt = failure.retryAt;
    }
}
const errorCodes = new Set([
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
function isAuthFailure(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    return (typeof candidate.serverTime === "number" &&
        typeof candidate.error === "object" &&
        candidate.error !== null &&
        typeof candidate.error.message === "string" &&
        typeof candidate.error.code === "string" &&
        errorCodes.has(candidate.error.code) &&
        (candidate.retryAt === undefined || typeof candidate.retryAt === "number"));
}
function unavailable(message = "认证服务暂时不可用") {
    return new AuthClientError({
        error: { code: "UNAVAILABLE", message },
        serverTime: Date.now(),
    });
}
export function createAuthClient(options = {}) {
    const basePath = options.basePath?.replace(/\/+$/, "") || "/api/auth-kit";
    const requestFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    async function request(path, method, body) {
        if (requestFetch === undefined)
            throw unavailable();
        let response;
        try {
            response = await requestFetch(`${basePath}${path}`, {
                method,
                credentials: "same-origin",
                headers: body === undefined
                    ? { accept: "application/json" }
                    : {
                        accept: "application/json",
                        "content-type": "application/json",
                    },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        }
        catch (error) {
            if (error instanceof AuthClientError)
                throw error;
            throw unavailable();
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            throw unavailable();
        }
        if (!response.ok) {
            if (isAuthFailure(payload))
                throw new AuthClientError(payload);
            throw unavailable();
        }
        return payload;
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
