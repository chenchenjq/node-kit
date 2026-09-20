"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { Feedback, Field, safeMessage } from "./shared.js";
export function TextGenerationExample({ listPlans, stream, className, }) {
    const [plans, setPlans] = useState([]), [code, setCode] = useState(""), [input, setInput] = useState(""), [text, setText] = useState(""), [status, setStatus] = useState(""), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), controller = useRef(null);
    useEffect(() => {
        let active = true;
        listPlans().then((rows) => {
            if (active) {
                setPlans(rows);
                setCode(rows.find((p) => p.isDefault)?.code ?? rows[0]?.code ?? "");
                if (!rows.length)
                    setStatus("没有获准方案，请联系管理员");
            }
        }, () => {
            if (active) {
                setFailed(true);
                setStatus("无法查询获准方案，请重新加载页面");
            }
        });
        return () => {
            active = false;
            controller.current?.abort();
        };
    }, [listPlans]);
    async function generate() {
        if (controller.current || !code)
            return;
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
                if (e.type === "text-delta")
                    setText((t) => t + e.delta);
                if (e.type === "finish") {
                    terminal = true;
                    setStatus(`${e.result.status === "completed" ? "生成完成" : "未完成"} · ${e.result.modelId} · ${e.result.durationMs} ms · usage ${e.result.usage ? JSON.stringify(e.result.usage) : "unknown"}`);
                }
                if (e.type === "error") {
                    terminal = true;
                    setFailed(true);
                    setStatus(e.error.code === "CANCELLED"
                        ? "已取消"
                        : e.error.code === "TIMEOUT"
                            ? "请求超时；结果可能未知"
                            : e.error.code === "STREAM_INTERRUPTED"
                                ? "流中断，保留已收到的正文"
                                : safeMessage(e.error));
                }
            }
            if (!terminal) {
                setFailed(true);
                setStatus("流已结束，但没有最终状态");
            }
        }
        catch (error) {
            setFailed(true);
            setStatus(c.signal.aborted ? "已取消" : safeMessage(error));
        }
        finally {
            controller.current = null;
            setBusy(false);
        }
    }
    return (_jsxs("form", { className: className ?? "ai-kit-form", noValidate: true, onSubmit: (e) => {
            e.preventDefault();
            void generate();
        }, "aria-busy": busy, children: [_jsx("h2", { children: "\u4E1A\u52A1\u6587\u672C\u8C03\u7528\u793A\u4F8B" }), _jsx(Field, { label: "\u83B7\u51C6\u65B9\u6848", children: (id) => (_jsx("select", { id: id, value: code, disabled: busy, onChange: (e) => setCode(e.target.value), children: plans.map((p) => (_jsxs("option", { value: p.code, children: [p.name, " \u00B7 ", p.code] }, p.code))) })) }), _jsx(Field, { label: "\u7528\u6237\u6587\u672C", children: (id) => (_jsx("textarea", { className: "resize-none", id: id, style: { resize: "none" }, rows: 4, maxLength: 32000, value: input, disabled: busy, onChange: (e) => setInput(e.target.value) })) }), _jsx("button", { disabled: busy || !code || !input.trim(), type: "submit", children: busy ? "生成中…" : "生成文本" }), _jsx("button", { type: "button", disabled: !busy, onClick: () => controller.current?.abort(), children: "\u53D6\u6D88\u751F\u6210" }), _jsx("pre", { "aria-label": "\u751F\u6210\u6B63\u6587", children: text }), _jsx(Feedback, { message: status, failed: failed })] }));
}
