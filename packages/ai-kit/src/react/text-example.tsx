"use client";
import { useEffect, useRef, useState } from "react";
import type { CallInput, PlanSummary, StreamEvent } from "../types.js";
import { Feedback, Field, safeMessage } from "./shared.js";
export interface TextGenerationExampleProps {
  listPlans(): Promise<PlanSummary[]>;
  stream(input: CallInput): AsyncIterable<StreamEvent>;
  className?: string | undefined;
}
export function TextGenerationExample({
  listPlans,
  stream,
  className,
}: TextGenerationExampleProps) {
  const [plans, setPlans] = useState<PlanSummary[]>([]),
    [code, setCode] = useState(""),
    [input, setInput] = useState(""),
    [text, setText] = useState(""),
    [status, setStatus] = useState(""),
    [failed, setFailed] = useState(false),
    [busy, setBusy] = useState(false),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    listPlans().then(
      (rows) => {
        if (active) {
          setPlans(rows);
          setCode(rows.find((p) => p.isDefault)?.code ?? rows[0]?.code ?? "");
          if (!rows.length) setStatus("没有获准方案，请联系管理员");
        }
      },
      () => {
        if (active) {
          setFailed(true);
          setStatus("无法查询获准方案，请重新加载页面");
        }
      },
    );
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [listPlans]);
  async function generate() {
    if (controller.current || !code) return;
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setFailed(false);
    setText("");
    setStatus("正在生成…");
    let terminal = false;
    try {
      for await (const e of stream({
        code,
        messages: [{ role: "user", content: input }],
        signal: c.signal,
      })) {
        if (e.type === "text-delta") setText((t) => t + e.delta);
        if (e.type === "finish") {
          terminal = true;
          setStatus(
            `${e.result.status === "completed" ? "生成完成" : "未完成"} · ${e.result.modelId} · ${e.result.durationMs} ms · usage ${e.result.usage ? JSON.stringify(e.result.usage) : "unknown"}`,
          );
        }
        if (e.type === "error") {
          terminal = true;
          setFailed(true);
          setStatus(
            e.error.code === "CANCELLED"
              ? "已取消"
              : e.error.code === "TIMEOUT"
                ? "请求超时；结果可能未知"
                : e.error.code === "STREAM_INTERRUPTED"
                  ? "流中断，保留已收到的正文"
                  : safeMessage(e.error),
          );
        }
      }
      if (!terminal) {
        setFailed(true);
        setStatus("流已结束，但没有最终状态");
      }
    } catch (error) {
      setFailed(true);
      setStatus(c.signal.aborted ? "已取消" : safeMessage(error));
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }
  return (
    <form
      className={className ?? "ai-kit-form"}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void generate();
      }}
      aria-busy={busy}
    >
      <h2>业务文本调用示例</h2>
      <Field label="获准方案">
        {(id) => (
          <select
            id={id}
            value={code}
            disabled={busy}
            onChange={(e) => setCode(e.target.value)}
          >
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name} · {p.code}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="用户文本">
        {(id) => (
          <textarea
            className="resize-none"
            id={id}
            style={{ resize: "none" }}
            rows={4}
            maxLength={32000}
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
          />
        )}
      </Field>
      <button disabled={busy || !code || !input.trim()} type="submit">
        {busy ? "生成中…" : "生成文本"}
      </button>
      <button
        type="button"
        disabled={!busy}
        onClick={() => controller.current?.abort()}
      >
        取消生成
      </button>
      <pre aria-label="生成正文">{text}</pre>
      <Feedback message={status} failed={failed} />
    </form>
  );
}
