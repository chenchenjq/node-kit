const messages = {
    INVALID_CONFIG: "配置无效，请核对配置与宿主安全能力",
    INVALID_INPUT: "输入无效或超过宿主限制",
    UNSUPPORTED_PROVIDER: "该厂商尚未提供适配",
    UNSUPPORTED_PROTOCOL: "该厂商不支持所选协议",
    UNSUPPORTED_PARAMETER: "该模型不支持指定参数或参数超出核实范围",
    MODEL_CAPABILITIES_REQUIRED: "手填模型需要宿主提供核实的参数能力",
    FORBIDDEN: "宿主授权拒绝",
    RATE_LIMITED: "请求被限流，请稍后重试",
    NOT_FOUND: "配置不存在",
    DISABLED: "方案或连接已停用",
    NO_DEFAULT_PLAN: "没有启用的默认方案",
    DEFAULT_REQUIRES_ACTION: "请明确清空或重新指定默认方案",
    CONFLICT: "配置已变更，请重新加载",
    CONNECTION_IN_USE: "连接被方案引用，不能删除",
    CREDENTIAL_SECURITY_REQUIRED: "缺少安全凭据处理能力",
    CREDENTIAL_FAILURE: "凭据安全读取失败",
    KEY_DOMAIN_CONFIRMATION_REQUIRED: "地址或厂商用途变化，请重新确认密钥用途",
    UNSAFE_URL: "目标地址未通过安全核验",
    AUTHENTICATION: "厂商凭据鉴权失败",
    QUOTA: "厂商额度不足",
    MODEL_PERMISSION: "模型不存在或无访问权限",
    PARAMETER: "厂商拒绝模型参数",
    NETWORK: "网络请求失败，结果可能未知",
    TIMEOUT: "请求超时，结果可能未知",
    CANCELLED: "请求已取消",
    OUTPUT_LIMIT: "输出超过宿主限制",
    STREAM_INTERRUPTED: "流中断，未取得最终状态",
    PROVIDER_ERROR: "厂商调用失败",
    MODEL_REFRESH_UNSUPPORTED: "该厂商未提供已核实的模型刷新接口",
};
export class AiKitError extends Error {
    code;
    constructor(code) {
        super(messages[code]);
        this.name = "AiKitError";
        this.code = code;
    }
    toJSON() {
        return { code: this.code, message: this.message };
    }
}
export function sanitizeError(error) {
    if (error instanceof AiKitError)
        return error;
    // The SDK wraps failed response reads in APICallError. Preserve only our fixed safe code.
    let nested = error;
    const seen = new Set();
    for (let depth = 0; depth < 5 && nested && typeof nested === "object" && !seen.has(nested); depth++) {
        seen.add(nested);
        nested = nested.cause;
        if (nested instanceof AiKitError)
            return new AiKitError(nested.code);
    }
    // Examine status and vendor machine code privately. Never preserve raw cause/body/message.
    const e = error && typeof error === "object"
        ? error
        : {};
    const status = Number(e.statusCode ?? e.status);
    let code = "";
    try {
        const data = typeof e.responseBody === "string"
            ? JSON.parse(e.responseBody)
            : e.data;
        const inner = data?.error;
        code = String(inner?.code ?? inner?.type ?? data?.code ?? "");
    }
    catch {
        /* Raw payload is intentionally discarded. */
    }
    if (/insufficient_quota|credit_balance|quota|balance|billing/i.test(code) ||
        status === 402)
        return new AiKitError("QUOTA");
    if (status === 401)
        return new AiKitError("AUTHENTICATION");
    if (status === 403 || status === 404)
        return new AiKitError("MODEL_PERMISSION");
    if (status === 429)
        return new AiKitError("RATE_LIMITED");
    if (status === 400 || status === 422)
        return new AiKitError("PARAMETER");
    if (e.name === "TimeoutError")
        return new AiKitError("TIMEOUT");
    if (e.name === "AbortError")
        return new AiKitError("CANCELLED");
    return new AiKitError(Number.isFinite(status) && status >= 500 ? "PROVIDER_ERROR" : "NETWORK");
}
