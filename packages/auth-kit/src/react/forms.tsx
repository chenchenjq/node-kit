"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from "react";
import { AuthClientError, createAuthClient, type AuthClient } from "./client.js";
import type { Captcha, CaptchaPurpose } from "../types.js";

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
.auth-kit__captcha { display: grid; grid-template-columns: minmax(0, 1fr) 7.5rem 2.65rem; gap: 0.625rem; align-items: end; }
.auth-kit__button.auth-kit__captcha-refresh { display: grid; place-items: center; width: 2.65rem; height: 2.65rem; min-height: 0; padding: 0; }
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
  .auth-kit__captcha { grid-template-columns: minmax(0, 1fr) 6rem 2.65rem; gap: 0.375rem; }
  .auth-kit__send-row { grid-template-columns: minmax(0, 1fr) 6.8rem; }
}
@media (prefers-reduced-motion: reduce) { .auth-kit * { scroll-behavior: auto !important; } }
`;

function captchaDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function messageFrom(error: unknown): string {
  return error instanceof AuthClientError
    ? error.message
    : "操作未完成，请重试";
}

function isPhone(value: string): boolean {
  return /^(?:\+?86)?1[3-9]\d{9}$/.test(value);
}

function phoneCooldownKey(value: string): string {
  return value.replace(/^\+?86(?=1[3-9]\d{9}$)/, "");
}

function isNewPassword(value: string): boolean {
  return (
    value.length >= 8 &&
    value.length <= 128 &&
    /[a-z]/i.test(value) &&
    /\d/.test(value)
  );
}

function purposeFor(
  view: AuthFormView,
  method: "password" | "sms"
): CaptchaPurpose | null {
  if (view === "reset-password") return "password-reset";
  if (view === "login")
    return method === "password" ? "password-login" : "sms-login";
  return null;
}

export type AuthFormView = "login" | "reset-password" | "change-password";
export type AuthFormSuccess =
  | "sign-in"
  | "password-reset"
  | "password-change";

export type AuthFormsProps = {
  client?: AuthClient;
  basePath?: string;
  fetch?: typeof fetch;
  initialView?: AuthFormView;
  className?: string;
  onSuccess?: (action: AuthFormSuccess) => void;
};

export function AuthForms({
  client: providedClient,
  basePath,
  fetch: requestFetch,
  initialView = "login",
  className,
  onSuccess,
}: AuthFormsProps): JSX.Element {
  const titleId = useId();
  const phoneId = useId();
  const phoneHintId = useId();

  const client = useMemo(
    () =>
      providedClient ??
      createAuthClient({
        ...(basePath === undefined ? {} : { basePath }),
        ...(requestFetch === undefined ? {} : { fetch: requestFetch }),
      }),
    [basePath, providedClient, requestFetch]
  );

  const [view, setView] = useState<AuthFormView>(initialView);
  const [method, setMethod] = useState<"password" | "sms">("password");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  const captchaRequest = useRef(0);
  const captchaQueue = useRef<Promise<void>>(Promise.resolve());
  const purpose = purposeFor(view, method);
  const phone = phoneNumber.trim();
  const cooldownKey = phoneCooldownKey(phone);
  const retryAt = cooldowns[cooldownKey];
  const remainingSeconds =
    retryAt === undefined ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));

  const loadCaptcha = useCallback(
    async (targetPurpose: CaptchaPurpose) => {
      const requestId = ++captchaRequest.current;
      setCaptchaLoading(true);
      setCaptcha(null);
      setCaptchaAnswer("");
      try {
        const pending=captchaQueue.current.then(()=>client.captcha(targetPurpose));
        captchaQueue.current=pending.then(()=>undefined,()=>undefined);
        const nextCaptcha = await pending;
        if (captchaRequest.current === requestId) setCaptcha(nextCaptcha);
      } catch (caught) {
        if (captchaRequest.current === requestId) setError(messageFrom(caught));
      } finally {
        if (captchaRequest.current === requestId) setCaptchaLoading(false);
      }
    },
    [client]
  );

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
    if (retryAt === undefined || retryAt <= Date.now()) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  function recordRetry(serverRetryAt: number, serverTime: number): void {
    const localRetryAt = Date.now() + Math.max(0, serverRetryAt - serverTime);
    setCooldowns((current) => ({ ...current, [cooldownKey]: localRetryAt }));
    setNow(Date.now());
  }

  function clearFeedback(): void {
    setError("");
    setStatus("");
  }

  function validatePhone(): boolean {
    if (!isPhone(phone)) {
      setError("请输入有效的中国大陆手机号");
      return false;
    }
    return true;
  }

  function validatedCaptcha(): Captcha | null {
    if (captcha === null || captchaAnswer.trim().length !== 4) {
      setError("请输入 4 位图形验证码");
      return null;
    }
    return captcha;
  }

  async function sendCode(): Promise<void> {
    if (busy !== null || remainingSeconds > 0) return;
    clearFeedback();
    if (!validatePhone()) return;
    const activeCaptcha = validatedCaptcha();
    if (
      activeCaptcha === null ||
      purpose === null ||
      purpose === "password-login"
    )
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
    } catch (caught) {
      if (caught instanceof AuthClientError && caught.retryAt !== undefined) {
        recordRetry(caught.retryAt, caught.serverTime);
      }
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
      void loadCaptcha(purpose);
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy !== null) return;
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
      } catch (caught) {
        setError(messageFrom(caught));
      } finally {
        setBusy(null);
      }
      return;
    }

    if (view === "login" && method === "password") {
      if (!phone || phone.length > 255) {
        setError("请输入邮箱或手机号");
        return;
      }
      if (password.length === 0) {
        setError("请输入密码");
        return;
      }
      const activeCaptcha = validatedCaptcha();
      if (activeCaptcha === null) return;
      setBusy("authenticate");
      try {
        await client.signInPassword({
          loginId: phone,
          password,
          captchaId: activeCaptcha.id,
          captchaAnswer: captchaAnswer.trim(),
        });
        setPassword("");
        setCaptchaAnswer("");
        setStatus("登录成功");
        onSuccess?.("sign-in");
      } catch (caught) {
        setError(messageFrom(caught));
        if (purpose !== null) void loadCaptcha(purpose);
      } finally {
        setBusy(null);
      }
      return;
    }

    if (!validatePhone()) return;
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
      } else {
        await client.signInSms({ phoneNumber: phone, code });
        setCode("");
        setStatus("登录成功");
        onSuccess?.("sign-in");
      }
    } catch (caught) {
      setError(messageFrom(caught));
      if (purpose !== null) void loadCaptcha(purpose);
    } finally {
      setBusy(null);
    }
  }

  function showLogin(nextMethod: "password" | "sms"): void {
    clearFeedback();
    setPassword("");
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setMethod(nextMethod);
    setView("login");
  }

  function showReset(): void {
    clearFeedback();
    setPassword("");
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setView("reset-password");
  }

  const isBusy = busy !== null;
  const title =
    view === "login"
      ? "登录"
      : view === "reset-password"
        ? "重置密码"
        : "修改密码";
  const subtitle =
    view === "login"
      ? method === "password"
        ? "使用邮箱或手机号和密码登录"
        : "使用短信验证码登录"
      : view === "reset-password"
        ? "验证手机号后设置新密码"
        : "更新当前账户的登录密码";
  const primaryLabel =
    busy === "authenticate"
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

  return (
    <section
      className={rootClassName}
      aria-labelledby={titleId}
      aria-busy={isBusy}
    >
      <style>{styles}</style>
      <header className="auth-kit__header">
        <h2 className="auth-kit__title" id={titleId}>
          {title}
        </h2>
        <p className="auth-kit__subtitle">{subtitle}</p>
      </header>
      <form
        className="auth-kit__form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {view !== "change-password" ? (
          <div className="auth-kit__field">
            <label className="auth-kit__label" htmlFor={phoneId}>
              {view === "login" && method === "password" ? "邮箱 / 手机号" : "手机号"}
            </label>
            <input
              id={phoneId}
              className="auth-kit__input"
              type={view === "login" && method === "password" ? "text" : "tel"}
              name={view === "login" && method === "password" ? "loginId" : "phoneNumber"}
              autoComplete="username"
              inputMode={view === "login" && method === "password" ? "text" : "tel"}
              aria-describedby={phoneHintId}
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.currentTarget.value)}
              disabled={isBusy}
            />
            <span className="auth-kit__hint" id={phoneHintId}>
              {view === "login" && method === "password"
                ? "请输入邮箱或已绑定的手机号"
                : "例如 13800138000 或 +8613800138000"}
            </span>
          </div>
        ) : null}

        {view === "login" && method === "password" ? (
          <label className="auth-kit__field">
            <span className="auth-kit__label">密码</span>
            <input
              className="auth-kit__input"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              disabled={isBusy}
            />
          </label>
        ) : null}

        {purpose !== null ? (
          <CaptchaField
            captcha={captcha}
            loading={captchaLoading}
            answer={captchaAnswer}
            disabled={isBusy}
            onAnswer={setCaptchaAnswer}
            onRefresh={() => void loadCaptcha(purpose)}
          />
        ) : null}

        {view === "reset-password" || (view === "login" && method === "sms") ? (
          <div className="auth-kit__send-row">
            <label className="auth-kit__field">
              <span className="auth-kit__label">短信验证码（6 位）</span>
              <input
                className="auth-kit__input"
                type="text"
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(event) =>
                  setCode(
                    event.currentTarget.value.replace(/\D/g, "").slice(0, 6)
                  )
                }
                disabled={isBusy}
              />
            </label>
            <button
              className="auth-kit__button auth-kit__button--secondary"
              type="button"
              onClick={() => void sendCode()}
              disabled={isBusy || captchaLoading || remainingSeconds > 0}
            >
              {busy === "send-sms"
                ? "正在发送"
                : remainingSeconds > 0
                  ? `已发送(${remainingSeconds})`
                  : "发送验证码"}
            </button>
          </div>
        ) : null}

        {view === "change-password" ? (
          <>
            <PasswordField
              label="当前密码"
              name="currentPassword"
              autoComplete="current-password"
              value={currentPassword}
              disabled={isBusy}
              onChange={setCurrentPassword}
            />
            <PasswordField
              label="新密码"
              name="newPassword"
              autoComplete="new-password"
              value={newPassword}
              disabled={isBusy}
              onChange={setNewPassword}
              hint="8–128 个字符，须包含英文字母和数字"
            />
            <PasswordField
              label="确认新密码"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              disabled={isBusy}
              onChange={setConfirmPassword}
            />
          </>
        ) : null}

        {view === "reset-password" ? (
          <>
            <PasswordField
              label="新密码"
              name="newPassword"
              autoComplete="new-password"
              value={newPassword}
              disabled={isBusy}
              onChange={setNewPassword}
              hint="8–128 个字符，须包含英文字母和数字"
            />
            <PasswordField
              label="确认新密码"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              disabled={isBusy}
              onChange={setConfirmPassword}
            />
          </>
        ) : null}

        <div aria-live="assertive" aria-atomic="true">
          <p
            className="auth-kit__message auth-kit__message--error"
            role={error ? "alert" : undefined}
          >
            {error}
          </p>
        </div>

        {status ? (
          <p className="auth-kit__message auth-kit__message--success" role="status">
            {status}
          </p>
        ) : null}

        <div className="auth-kit__actions">
          {view === "reset-password" ? (
            <button
              className="auth-kit__button auth-kit__button--link"
              type="button"
              onClick={() => showLogin("password")}
              disabled={isBusy}
            >
              返回登录
            </button>
          ) : null}
          <button
            className="auth-kit__button auth-kit__button--primary"
            type="submit"
            disabled={isBusy}
          >
            {primaryLabel}
          </button>
        </div>

        {view === "login" ? (
          <div className="auth-kit__switches">
            <button
              className="auth-kit__button auth-kit__button--link"
              type="button"
              onClick={() =>
                showLogin(method === "password" ? "sms" : "password")
              }
              disabled={isBusy}
            >
              {method === "password" ? "验证码登录" : "密码登录"}
            </button>
            <button
              className="auth-kit__button auth-kit__button--link"
              type="button"
              onClick={showReset}
              disabled={isBusy}
            >
              忘记密码？
            </button>
          </div>
        ) : null}
      </form>
    </section>
  );
}

function CaptchaField({
  captcha,
  loading,
  answer,
  disabled,
  onAnswer,
  onRefresh,
}: {
  captcha: Captcha | null;
  loading: boolean;
  answer: string;
  disabled: boolean;
  onAnswer: (value: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="auth-kit__captcha">
      <label className="auth-kit__field">
        <span className="auth-kit__label">验证码</span>
        <input
          className="auth-kit__input"
          type="text"
          name="captchaAnswer"
          autoComplete="off"
          maxLength={4}
          value={answer}
          onChange={(event) =>
            onAnswer(event.currentTarget.value.slice(0, 4))
          }
          disabled={disabled || loading}
        />
      </label>
      <div className="auth-kit__field">
        <div className="auth-kit__captcha-visual">
          {captcha === null ? (
            <span className="auth-kit__captcha-loading" role="status">
              {loading ? "正在加载" : "加载失败"}
            </span>
          ) : (
            <img
              className="auth-kit__captcha-image"
              src={captchaDataUrl(captcha.image)}
              alt="图形验证码"
              width="120"
              height="42"
            />
          )}
        </div>
      </div>
      <button
        className="auth-kit__button auth-kit__button--link auth-kit__captcha-refresh"
        type="button"
        onClick={onRefresh}
        disabled={disabled || loading}
        aria-label="刷新验证码"
        title="刷新验证码"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 7v5h-5" />
          <path d="M4 17v-5h5" />
          <path d="M6.1 7a7 7 0 0 1 11.55-2L20 8M4 16l2.35 3A7 7 0 0 0 17.9 17" />
        </svg>
      </button>
    </div>
  );
}

function PasswordField({
  label,
  name,
  autoComplete,
  value,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  name: string;
  autoComplete: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  hint?: string;
}): JSX.Element {
  const inputId = useId();
  const hintId = useId();

  return (
    <div className="auth-kit__field">
      <label className="auth-kit__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="auth-kit__input"
        type="password"
        name={name}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        disabled={disabled}
        {...(hint === undefined ? {} : { "aria-describedby": hintId })}
      />
      {hint === undefined ? null : (
        <span className="auth-kit__hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

