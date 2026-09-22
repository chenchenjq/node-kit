"use client";
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useId, useMemo, useRef, useState, } from "react";
import { AuthClientError, createAuthClient, } from "./client.js";
const styles = `
.auth-kit {
  --auth-kit-bg: #ffffff;
  --auth-kit-text: #17202a;
  --auth-kit-muted: #667085;
  --auth-kit-line: #d8dee7;
  --auth-kit-soft: #f5f7fa;
  --auth-kit-accent: #215b8f;
  --auth-kit-accent-hover: #174873;
  --auth-kit-danger: #b42318;
  --auth-kit-success: #18704a;
  width: min(100%, 25rem);
  box-sizing: border-box;
  border: 1px solid var(--auth-kit-line);
  border-radius: 0.75rem;
  background: var(--auth-kit-bg);
  color: var(--auth-kit-text);
  box-shadow: 0 0.75rem 2rem rgba(23, 32, 42, 0.08);
  padding: 1.5rem;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 0.9375rem;
  line-height: 1.5;
}
.auth-kit *, .auth-kit *::before, .auth-kit *::after { box-sizing: border-box; }
.auth-kit__header { margin-bottom: 1.25rem; }
.auth-kit__title { margin: 0; font-size: 1.35rem; line-height: 1.25; font-weight: 650; letter-spacing: -0.015em; }
.auth-kit__subtitle { min-height: 1.4rem; margin: 0.3rem 0 0; color: var(--auth-kit-muted); font-size: 0.875rem; }
.auth-kit__form { display: grid; gap: 1rem; }
.auth-kit__field { display: grid; gap: 0.375rem; }
.auth-kit__label { font-weight: 600; }
.auth-kit__hint { margin: 0; color: var(--auth-kit-muted); font-size: 0.8rem; }
.auth-kit__input {
  width: 100%; min-height: 2.65rem; border: 1px solid var(--auth-kit-line); border-radius: 0.5rem;
  background: var(--auth-kit-bg); color: var(--auth-kit-text); padding: 0.62rem 0.72rem; font: inherit;
}
.auth-kit__input:hover { border-color: #aab4c3; }
.auth-kit__input:focus-visible, .auth-kit__button:focus-visible {
  outline: 3px solid rgba(33, 91, 143, 0.24); outline-offset: 2px;
}
.auth-kit__captcha { display: grid; grid-template-columns: minmax(0, 1fr) 7.5rem; gap: 0.625rem; align-items: end; }
.auth-kit__captcha-refresh { grid-column: 2; }
.auth-kit__captcha-visual {
  position: relative; display: grid; place-items: center; height: 2.65rem; overflow: hidden;
  border: 1px solid var(--auth-kit-line); border-radius: 0.5rem; background: var(--auth-kit-soft);
}
.auth-kit__captcha-image { display: block; width: 100%; height: 100%; object-fit: cover; }
.auth-kit__captcha-loading { color: var(--auth-kit-muted); font-size: 0.75rem; }
.auth-kit__button {
  min-height: 2.65rem; border: 1px solid transparent; border-radius: 0.5rem; padding: 0.58rem 0.8rem;
  font: inherit; font-weight: 650; line-height: 1.25; cursor: pointer;
}
.auth-kit__button:disabled { cursor: not-allowed; opacity: 0.58; }
.auth-kit__button--primary { background: var(--auth-kit-accent); color: #fff; }
.auth-kit__button--primary:hover:not(:disabled) { background: var(--auth-kit-accent-hover); }
.auth-kit__button--secondary { border-color: var(--auth-kit-line); background: var(--auth-kit-soft); color: var(--auth-kit-text); }
.auth-kit__button--secondary:hover:not(:disabled) { border-color: #aab4c3; background: #eef2f6; }
.auth-kit__button--link { min-height: auto; border: 0; background: transparent; color: var(--auth-kit-accent); padding: 0.2rem; font-weight: 600; }
.auth-kit__button--link:hover:not(:disabled) { color: var(--auth-kit-accent-hover); text-decoration: underline; }
.auth-kit__send-row { display: grid; grid-template-columns: minmax(0, 1fr) 7.5rem; gap: 0.625rem; align-items: end; }
.auth-kit__actions { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.auth-kit__actions .auth-kit__button--primary { flex: 1; }
.auth-kit__message { min-height: 1.4rem; margin: 0; font-size: 0.875rem; }
.auth-kit__message--error { color: var(--auth-kit-danger); }
.auth-kit__message--success { color: var(--auth-kit-success); }
.auth-kit__switches { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 0.1rem; }
@media (max-width: 24rem) {
  .auth-kit { padding: 1.15rem; border-radius: 0.625rem; }
  .auth-kit__captcha, .auth-kit__send-row { grid-template-columns: minmax(0, 1fr) 6.8rem; }
}
@media (prefers-reduced-motion: reduce) { .auth-kit * { scroll-behavior: auto !important; } }
`;
function captchaDataUrl(svg) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function messageFrom(error) {
    return error instanceof AuthClientError
        ? error.message
        : "操作未完成，请重试";
}
function isPhone(value) {
    return /^(?:\+?86)?1[3-9]\d{9}$/.test(value);
}
function phoneCooldownKey(value) {
    return value.replace(/^\+?86(?=1[3-9]\d{9}$)/, "");
}
function isNewPassword(value) {
    return (value.length >= 8 &&
        value.length <= 128 &&
        /[a-z]/i.test(value) &&
        /\d/.test(value));
}
function purposeFor(view, method) {
    if (view === "reset-password")
        return "password-reset";
    if (view === "login")
        return method === "password" ? "password-login" : "sms-login";
    return null;
}
export function AuthForms({ client: providedClient, basePath, fetch: requestFetch, initialView = "login", className, onSuccess, }) {
    const titleId = useId();
    const phoneId = useId();
    const phoneHintId = useId();
    const client = useMemo(() => providedClient ??
        createAuthClient({
            ...(basePath === undefined ? {} : { basePath }),
            ...(requestFetch === undefined ? {} : { fetch: requestFetch }),
        }), [basePath, providedClient, requestFetch]);
    const [view, setView] = useState(initialView);
    const [method, setMethod] = useState("password");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [password, setPassword] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [code, setCode] = useState("");
    const [captchaAnswer, setCaptchaAnswer] = useState("");
    const [captcha, setCaptcha] = useState(null);
    const [captchaLoading, setCaptchaLoading] = useState(false);
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [cooldowns, setCooldowns] = useState({});
    const [now, setNow] = useState(() => Date.now());
    const captchaRequest = useRef(0);
    const purpose = purposeFor(view, method);
    const phone = phoneNumber.trim();
    const cooldownKey = phoneCooldownKey(phone);
    const retryAt = cooldowns[cooldownKey];
    const remainingSeconds = retryAt === undefined ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1_000));
    const loadCaptcha = useCallback(async (targetPurpose) => {
        const requestId = ++captchaRequest.current;
        setCaptchaLoading(true);
        setCaptcha(null);
        setCaptchaAnswer("");
        try {
            const nextCaptcha = await client.captcha(targetPurpose);
            if (captchaRequest.current === requestId)
                setCaptcha(nextCaptcha);
        }
        catch (caught) {
            if (captchaRequest.current === requestId)
                setError(messageFrom(caught));
        }
        finally {
            if (captchaRequest.current === requestId)
                setCaptchaLoading(false);
        }
    }, [client]);
    useEffect(() => {
        if (purpose === null) {
            captchaRequest.current += 1;
            setCaptcha(null);
            setCaptchaLoading(false);
            return;
        }
        void loadCaptcha(purpose);
    }, [loadCaptcha, purpose]);
    useEffect(() => {
        if (retryAt === undefined || retryAt <= Date.now())
            return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
    }, [retryAt]);
    function recordRetry(serverRetryAt, serverTime) {
        const localRetryAt = Date.now() + Math.max(0, serverRetryAt - serverTime);
        setCooldowns((current) => ({ ...current, [cooldownKey]: localRetryAt }));
        setNow(Date.now());
    }
    function clearFeedback() {
        setError("");
        setStatus("");
    }
    function validatePhone() {
        if (!isPhone(phone)) {
            setError("请输入有效的中国大陆手机号");
            return false;
        }
        return true;
    }
    function validatedCaptcha() {
        if (captcha === null || captchaAnswer.trim().length !== 4) {
            setError("请输入 4 位图形验证码");
            return null;
        }
        return captcha;
    }
    async function sendCode() {
        if (busy !== null || remainingSeconds > 0)
            return;
        clearFeedback();
        if (!validatePhone())
            return;
        const activeCaptcha = validatedCaptcha();
        if (activeCaptcha === null ||
            purpose === null ||
            purpose === "password-login")
            return;
        setBusy("send-sms");
        try {
            const result = await client.sendSms({
                phoneNumber: phone,
                purpose,
                captchaId: activeCaptcha.id,
                captchaAnswer: captchaAnswer.trim(),
            });
            recordRetry(result.retryAt, result.serverTime);
            setStatus("验证码已发送");
        }
        catch (caught) {
            if (caught instanceof AuthClientError && caught.retryAt !== undefined) {
                recordRetry(caught.retryAt, caught.serverTime);
            }
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
            void loadCaptcha(purpose);
        }
    }
    async function submit(event) {
        event.preventDefault();
        if (busy !== null)
            return;
        clearFeedback();
        if (view === "change-password") {
            if (currentPassword.length === 0 || newPassword.length === 0) {
                setError("请填写当前密码和新密码");
                return;
            }
            if (!isNewPassword(newPassword)) {
                setError("新密码须为 8–128 个字符，包含英文字母和数字");
                return;
            }
            if (newPassword !== confirmPassword) {
                setError("两次输入的新密码不一致");
                return;
            }
            setBusy("authenticate");
            try {
                await client.changePassword({ currentPassword, newPassword });
                setCurrentPassword("");
                setNewPassword("");
                setConfirmPassword("");
                setStatus("密码已更新");
                onSuccess?.("password-change");
            }
            catch (caught) {
                setError(messageFrom(caught));
            }
            finally {
                setBusy(null);
            }
            return;
        }
        if (!validatePhone())
            return;
        if (view === "login" && method === "password") {
            if (password.length === 0) {
                setError("请输入密码");
                return;
            }
            const activeCaptcha = validatedCaptcha();
            if (activeCaptcha === null)
                return;
            setBusy("authenticate");
            try {
                await client.signInPassword({
                    phoneNumber: phone,
                    password,
                    captchaId: activeCaptcha.id,
                    captchaAnswer: captchaAnswer.trim(),
                });
                setPassword("");
                setCaptchaAnswer("");
                setStatus("登录成功");
                onSuccess?.("sign-in");
            }
            catch (caught) {
                setError(messageFrom(caught));
                if (purpose !== null)
                    void loadCaptcha(purpose);
            }
            finally {
                setBusy(null);
            }
            return;
        }
        if (!/^\d{6}$/.test(code)) {
            setError("请输入 6 位短信验证码");
            return;
        }
        if (view === "reset-password") {
            if (newPassword.length === 0) {
                setError("请输入新密码");
                return;
            }
            if (!isNewPassword(newPassword)) {
                setError("新密码须为 8–128 个字符，包含英文字母和数字");
                return;
            }
            if (newPassword !== confirmPassword) {
                setError("两次输入的新密码不一致");
                return;
            }
        }
        setBusy("authenticate");
        try {
            if (view === "reset-password") {
                await client.resetPassword({ phoneNumber: phone, code, newPassword });
                setCode("");
                setNewPassword("");
                setConfirmPassword("");
                setMethod("password");
                setView("login");
                setStatus("密码已重置，请使用新密码登录");
                onSuccess?.("password-reset");
            }
            else {
                await client.signInSms({ phoneNumber: phone, code });
                setCode("");
                setStatus("登录成功");
                onSuccess?.("sign-in");
            }
        }
        catch (caught) {
            setError(messageFrom(caught));
            if (purpose !== null)
                void loadCaptcha(purpose);
        }
        finally {
            setBusy(null);
        }
    }
    function showLogin(nextMethod) {
        clearFeedback();
        setPassword("");
        setCode("");
        setNewPassword("");
        setConfirmPassword("");
        setMethod(nextMethod);
        setView("login");
    }
    function showReset() {
        clearFeedback();
        setPassword("");
        setCode("");
        setNewPassword("");
        setConfirmPassword("");
        setView("reset-password");
    }
    const isBusy = busy !== null;
    const title = view === "login"
        ? "登录"
        : view === "reset-password"
            ? "重置密码"
            : "修改密码";
    const subtitle = view === "login"
        ? method === "password"
            ? "使用手机号和密码登录"
            : "使用短信验证码登录"
        : view === "reset-password"
            ? "验证手机号后设置新密码"
            : "更新当前账户的登录密码";
    const primaryLabel = busy === "authenticate"
        ? view === "login"
            ? "正在登录"
            : view === "reset-password"
                ? "正在重置密码"
                : "正在更新密码"
        : view === "login"
            ? "登录"
            : view === "reset-password"
                ? "重置密码"
                : "更新密码";
    const rootClassName = ["auth-kit", className].filter(Boolean).join(" ");
    return (_jsxs("section", { className: rootClassName, "aria-labelledby": titleId, "aria-busy": isBusy, children: [_jsx("style", { children: styles }), _jsxs("header", { className: "auth-kit__header", children: [_jsx("h2", { className: "auth-kit__title", id: titleId, children: title }), _jsx("p", { className: "auth-kit__subtitle", children: subtitle })] }), _jsxs("form", { className: "auth-kit__form", onSubmit: (event) => void submit(event), noValidate: true, children: [view !== "change-password" ? (_jsxs("div", { className: "auth-kit__field", children: [_jsx("label", { className: "auth-kit__label", htmlFor: phoneId, children: "\u624B\u673A\u53F7" }), _jsx("input", { id: phoneId, className: "auth-kit__input", type: "tel", name: "phoneNumber", autoComplete: "username", inputMode: "tel", "aria-describedby": phoneHintId, value: phoneNumber, onChange: (event) => setPhoneNumber(event.currentTarget.value), disabled: isBusy }), _jsx("span", { className: "auth-kit__hint", id: phoneHintId, children: "\u4F8B\u5982 13800138000 \u6216 +8613800138000" })] })) : null, view === "login" && method === "password" ? (_jsxs("label", { className: "auth-kit__field", children: [_jsx("span", { className: "auth-kit__label", children: "\u5BC6\u7801" }), _jsx("input", { className: "auth-kit__input", type: "password", name: "password", autoComplete: "current-password", value: password, onChange: (event) => setPassword(event.currentTarget.value), disabled: isBusy })] })) : null, purpose !== null ? (_jsx(CaptchaField, { captcha: captcha, loading: captchaLoading, answer: captchaAnswer, disabled: isBusy, onAnswer: setCaptchaAnswer, onRefresh: () => void loadCaptcha(purpose) })) : null, view === "reset-password" || (view === "login" && method === "sms") ? (_jsxs("div", { className: "auth-kit__send-row", children: [_jsxs("label", { className: "auth-kit__field", children: [_jsx("span", { className: "auth-kit__label", children: "\u77ED\u4FE1\u9A8C\u8BC1\u7801\uFF086 \u4F4D\uFF09" }), _jsx("input", { className: "auth-kit__input", type: "text", name: "code", autoComplete: "one-time-code", inputMode: "numeric", pattern: "[0-9]*", maxLength: 6, value: code, onChange: (event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6)), disabled: isBusy })] }), _jsx("button", { className: "auth-kit__button auth-kit__button--secondary", type: "button", onClick: () => void sendCode(), disabled: isBusy || captchaLoading || remainingSeconds > 0, children: busy === "send-sms"
                                    ? "正在发送"
                                    : remainingSeconds > 0
                                        ? `已发送(${remainingSeconds})`
                                        : "发送验证码" })] })) : null, view === "change-password" ? (_jsxs(_Fragment, { children: [_jsx(PasswordField, { label: "\u5F53\u524D\u5BC6\u7801", name: "currentPassword", autoComplete: "current-password", value: currentPassword, disabled: isBusy, onChange: setCurrentPassword }), _jsx(PasswordField, { label: "\u65B0\u5BC6\u7801", name: "newPassword", autoComplete: "new-password", value: newPassword, disabled: isBusy, onChange: setNewPassword, hint: "8\u2013128 \u4E2A\u5B57\u7B26\uFF0C\u987B\u5305\u542B\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57" }), _jsx(PasswordField, { label: "\u786E\u8BA4\u65B0\u5BC6\u7801", name: "confirmPassword", autoComplete: "new-password", value: confirmPassword, disabled: isBusy, onChange: setConfirmPassword })] })) : null, view === "reset-password" ? (_jsxs(_Fragment, { children: [_jsx(PasswordField, { label: "\u65B0\u5BC6\u7801", name: "newPassword", autoComplete: "new-password", value: newPassword, disabled: isBusy, onChange: setNewPassword, hint: "8\u2013128 \u4E2A\u5B57\u7B26\uFF0C\u987B\u5305\u542B\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57" }), _jsx(PasswordField, { label: "\u786E\u8BA4\u65B0\u5BC6\u7801", name: "confirmPassword", autoComplete: "new-password", value: confirmPassword, disabled: isBusy, onChange: setConfirmPassword })] })) : null, _jsx("div", { "aria-live": "assertive", "aria-atomic": "true", children: _jsx("p", { className: "auth-kit__message auth-kit__message--error", role: error ? "alert" : undefined, children: error }) }), status ? (_jsx("p", { className: "auth-kit__message auth-kit__message--success", role: "status", children: status })) : null, _jsxs("div", { className: "auth-kit__actions", children: [view === "reset-password" ? (_jsx("button", { className: "auth-kit__button auth-kit__button--link", type: "button", onClick: () => showLogin("password"), disabled: isBusy, children: "\u8FD4\u56DE\u767B\u5F55" })) : null, _jsx("button", { className: "auth-kit__button auth-kit__button--primary", type: "submit", disabled: isBusy, children: primaryLabel })] }), view === "login" ? (_jsxs("div", { className: "auth-kit__switches", children: [_jsx("button", { className: "auth-kit__button auth-kit__button--link", type: "button", onClick: () => showLogin(method === "password" ? "sms" : "password"), disabled: isBusy, children: method === "password" ? "验证码登录" : "密码登录" }), _jsx("button", { className: "auth-kit__button auth-kit__button--link", type: "button", onClick: showReset, disabled: isBusy, children: "\u5FD8\u8BB0\u5BC6\u7801\uFF1F" })] })) : null] })] }));
}
function CaptchaField({ captcha, loading, answer, disabled, onAnswer, onRefresh, }) {
    return (_jsxs("div", { className: "auth-kit__captcha", children: [_jsxs("label", { className: "auth-kit__field", children: [_jsx("span", { className: "auth-kit__label", children: "\u56FE\u5F62\u9A8C\u8BC1\u7801\uFF084 \u4F4D\uFF09" }), _jsx("input", { className: "auth-kit__input", type: "text", name: "captchaAnswer", autoComplete: "off", maxLength: 4, value: answer, onChange: (event) => onAnswer(event.currentTarget.value.slice(0, 4)), disabled: disabled || loading })] }), _jsxs("div", { className: "auth-kit__field", children: [_jsx("span", { className: "auth-kit__label", "aria-hidden": "true", children: "\u9A8C\u8BC1\u7801\u56FE\u7247" }), _jsx("div", { className: "auth-kit__captcha-visual", children: captcha === null ? (_jsx("span", { className: "auth-kit__captcha-loading", role: "status", children: loading ? "正在加载" : "加载失败" })) : (_jsx("img", { className: "auth-kit__captcha-image", src: captchaDataUrl(captcha.image), alt: "\u56FE\u5F62\u9A8C\u8BC1\u7801", width: "120", height: "42" })) })] }), _jsx("button", { className: "auth-kit__button auth-kit__button--link auth-kit__captcha-refresh", type: "button", onClick: onRefresh, disabled: disabled || loading, children: "\u6362\u4E00\u5F20" })] }));
}
function PasswordField({ label, name, autoComplete, value, disabled, onChange, hint, }) {
    const inputId = useId();
    const hintId = useId();
    return (_jsxs("div", { className: "auth-kit__field", children: [_jsx("label", { className: "auth-kit__label", htmlFor: inputId, children: label }), _jsx("input", { id: inputId, className: "auth-kit__input", type: "password", name: name, autoComplete: autoComplete, value: value, onChange: (event) => onChange(event.currentTarget.value), disabled: disabled, ...(hint === undefined ? {} : { "aria-describedby": hintId }) }), hint === undefined ? null : (_jsx("span", { className: "auth-kit__hint", id: hintId, children: hint }))] }));
}
