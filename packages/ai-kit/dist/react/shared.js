"use client";
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cloneElement, isValidElement, useId, useRef, useState } from "react";
export function Field({ label, children, hint, }) {
    const id = useId(), control = children(id);
    return (_jsxs("div", { className: "ai-kit-field", children: [_jsx("label", { htmlFor: id, children: label }), isValidElement(control)
                ? cloneElement(control, { "aria-describedby": hint ? `${id}-help` : undefined })
                : control, hint && _jsx("small", { id: `${id}-help`, children: hint })] }));
}
export function safeMessage(error) {
    const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    const messages = {
        CONFLICT: "配置已变更，请重新加载后保存",
        FORBIDDEN: "无操作权限，请联系宿主管理员",
        RATE_LIMITED: "请求过于频繁，请稍后重试",
        UNSAFE_URL: "地址未通过宿主安全核验",
        KEY_DOMAIN_CONFIRMATION_REQUIRED: "请重新确认密钥用途",
        UNSUPPORTED_PARAMETER: "参数不受支持，请核对模型限制",
        MODEL_CAPABILITIES_REQUIRED: "请宿主补充手填模型的参数能力",
        DEFAULT_REQUIRES_ACTION: "请先清空默认方案",
        CREDENTIAL_SECURITY_REQUIRED: "请宿主配置安全密钥处理能力",
    };
    return messages[code] ?? "操作失败，请核对输入或重新加载";
}
export function useOperation() {
    const [busy, setBusy] = useState(null), [message, setMessage] = useState(""), [failed, setFailed] = useState(false), pending = useRef(false);
    async function run(name, work) {
        if (pending.current)
            return;
        pending.current = true;
        setBusy(name);
        setMessage("");
        setFailed(false);
        try {
            await work();
            setMessage(`${name}完成`);
        }
        catch (error) {
            setMessage(safeMessage(error));
            setFailed(true);
        }
        finally {
            pending.current = false;
            setBusy(null);
        }
    }
    return { busy, message, failed, run };
}
export function Feedback({ message, failed, }) {
    return (_jsx("p", { role: failed ? "alert" : "status", "aria-live": "polite", className: "ai-kit-feedback", children: message || " " }));
}
export function TestFeedback({ value }) {
    if (!value)
        return null;
    const r = value.result;
    return (_jsxs("section", { "aria-label": "\u672C\u6B21\u6D4B\u8BD5\u7ED3\u679C", "aria-live": "polite", children: [_jsxs("p", { children: [value.status === "completed"
                        ? "测试完成"
                        : value.status === "incomplete"
                            ? "未完成：预算耗尽或未产生最终文本"
                            : "测试失败", " ", "\u00B7 ", value.durationMs, " ms"] }), value.error && (_jsxs("p", { role: "alert", children: [value.error.code, "\uFF1A", safeMessage(value.error)] })), r && (_jsxs(_Fragment, { children: [_jsxs("p", { children: [r.providerCode, " / ", r.modelId, " \u00B7 ", r.finishReason] }), _jsx("pre", { children: r.text.slice(0, 500) || "无最终正文" }), _jsxs("p", { children: ["usage\uFF1A", r.usage ? JSON.stringify(r.usage) : "unknown"] })] }))] }));
}
