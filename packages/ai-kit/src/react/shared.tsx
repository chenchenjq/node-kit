"use client";
import { cloneElement, isValidElement, useId, useRef, useState } from "react";
import type { ReactNode, ReactElement } from "react";
import type { TestResult } from "../types.js";
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: (id: string) => ReactNode;
  hint?: string;
}) {
  const id = useId(),
    control = children(id);
  return (
    <div className="ai-kit-field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(control)
        ? cloneElement(
            control as ReactElement<{
              "aria-describedby"?: string | undefined;
            }>,
            { "aria-describedby": hint ? `${id}-help` : undefined },
          )
        : control}
      {hint && <small id={`${id}-help`}>{hint}</small>}
    </div>
  );
}
export function safeMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const messages: Record<string, string> = {
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
  const [busy, setBusy] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false),
    pending = useRef(false);
  async function run(name: string, work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(name);
    setMessage("");
    setFailed(false);
    try {
      await work();
      setMessage(`${name}完成`);
    } catch (error) {
      setMessage(safeMessage(error));
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }
  return { busy, message, failed, run };
}
export function Feedback({
  message,
  failed,
}: {
  message: string;
  failed: boolean;
}) {
  return (
    <p
      role={failed ? "alert" : "status"}
      aria-live="polite"
      className="ai-kit-feedback"
    >
      {message || " "}
    </p>
  );
}
export function TestFeedback({ value }: { value: TestResult | null }) {
  if (!value) return null;
  const r = value.result;
  return (
    <section aria-label="本次测试结果" aria-live="polite">
      <p>
        {value.status === "completed"
          ? "测试完成"
          : value.status === "incomplete"
            ? "未完成：预算耗尽或未产生最终文本"
            : "测试失败"}{" "}
        · {value.durationMs} ms
      </p>
      {value.error && (
        <p role="alert">
          {value.error.code}：{safeMessage(value.error)}
        </p>
      )}
      {r && (
        <>
          <p>
            {r.providerCode} / {r.modelId} · {r.finishReason}
          </p>
          <pre>{r.text.slice(0, 500) || "无最终正文"}</pre>
          <p>usage：{r.usage ? JSON.stringify(r.usage) : "unknown"}</p>
        </>
      )}
    </section>
  );
}
