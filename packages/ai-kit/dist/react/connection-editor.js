"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useState } from "react";
import { modelPresets, providerAdapters } from "../catalog.js";
import { Feedback, Field, TestFeedback, useOperation } from "./shared.js";
export function ConnectionEditor({ providers, connection, save, test, className, }) {
    const first = providers.find((p) => p.enabled)?.code ?? "", initial = providerAdapters.find((a) => a.code === first);
    const [draft, setDraft] = useState(() => connection
        ? { ...connection, apiKey: "" }
        : {
            name: "",
            providerCode: first,
            protocol: initial?.recommendedProtocol ?? "openai-chat",
            baseURL: initial?.endpoints[0]?.baseURL ?? "",
            apiKey: "",
            enabled: true,
        });
    // Copy only write DTO fields; protected fields never enter this component.
    function input() {
        return {
            name: draft.name,
            providerCode: draft.providerCode,
            protocol: draft.protocol,
            baseURL: draft.baseURL,
            apiKey: draft.apiKey ?? "",
            enabled: draft.enabled,
            ...(connection
                ? { id: connection.id, revision: connection.revision }
                : {}),
            confirmKeyDomainChange: !!draft.confirmKeyDomainChange,
            clearDefault: !!draft.clearDefault,
        };
    }
    const [modelId, setModelId] = useState(modelPresets.find((p) => p.providerCode === draft.providerCode)
        ?.modelId ?? ""), [fee, setFee] = useState(false), [showKey, setShowKey] = useState(false), [tested, setTested] = useState(null), op = useOperation();
    const draftVersion = useRef(0), feedbackVersion = useRef(0);
    const adapter = providerAdapters.find((a) => a.code === draft.providerCode);
    function provider(code) {
        const a = providerAdapters.find((a) => a.code === code);
        setDraft((d) => ({
            ...d,
            providerCode: code,
            protocol: a?.recommendedProtocol ?? "openai-chat",
            baseURL: a?.endpoints[0]?.baseURL ?? "",
        }));
        setModelId(modelPresets.find((p) => p.providerCode === code)?.modelId ?? "");
        draftVersion.current++;
        setTested(null);
    }
    const patch = (changes) => {
        setDraft((d) => ({ ...d, ...changes }));
        draftVersion.current++;
        setTested(null);
    };
    return (_jsxs("form", { className: className ?? "ai-kit-form", noValidate: true, "aria-busy": !!op.busy, onSubmit: (e) => {
            e.preventDefault();
            void op.run("保存连接", async () => {
                feedbackVersion.current = draftVersion.current;
                setTested(null);
                const submitted = input();
                await save(submitted);
                setDraft((d) => d.apiKey === submitted.apiKey ? { ...d, apiKey: "" } : d);
            });
        }, children: [_jsx("h3", { children: connection ? "编辑连接" : "新增连接" }), _jsx(Field, { label: "\u8FDE\u63A5\u540D\u79F0", children: (id) => (_jsx("input", { id: id, value: draft.name, onChange: (e) => patch({ name: e.target.value }), required: true, maxLength: 100 })) }), _jsx(Field, { label: "\u5382\u5546", children: (id) => (_jsx("select", { id: id, value: draft.providerCode, onChange: (e) => provider(e.target.value), children: providers
                        .filter((p) => p.enabled || p.code === draft.providerCode)
                        .map((p) => (_jsx("option", { value: p.code, children: p.name }, p.code))) })) }), !adapter && _jsx("p", { role: "alert", children: "\u8BE5\u5B57\u5178\u5382\u5546\u5C1A\u65E0\u9002\u914D\uFF0C\u4E0D\u80FD\u4FDD\u5B58\u6216\u8C03\u7528\u3002" }), _jsx(Field, { label: "\u534F\u8BAE", children: (id) => (_jsx("select", { id: id, value: draft.protocol, onChange: (e) => patch({ protocol: e.target.value }), children: (adapter?.protocols ?? []).map((p) => (_jsx("option", { value: p, children: p === "openai-chat"
                            ? "OpenAI Chat Completions"
                            : p === "openai-responses"
                                ? "OpenAI Responses"
                                : "Anthropic Messages" }, p))) })) }), _jsx(Field, { label: "\u5730\u5740\u6A21\u677F", hint: "\u5730\u57DF\u548C\u4E1A\u52A1\u7A7A\u95F4\u7684\u5BC6\u94A5\u4E0D\u901A\u7528\uFF1B\u5957\u9910\u7AEF\u70B9\u8BF7\u6309\u5B98\u65B9\u6587\u6863\u6838\u5BF9\u7528\u9014\u3002", children: (id) => (_jsxs("select", { id: id, value: "", onChange: (e) => {
                        const t = adapter?.endpoints.find((t) => t.baseURL === e.target.value);
                        if (t)
                            patch({ baseURL: t.baseURL, protocol: t.protocol });
                    }, children: [_jsx("option", { value: "", children: "\u9009\u62E9\u666E\u901A API \u6A21\u677F" }), adapter?.endpoints.map((t) => (_jsxs("option", { value: t.baseURL, children: [t.name, " \u00B7 ", t.baseURL] }, t.baseURL)))] })) }), _jsx(Field, { label: "BaseURL", hint: "\u586B\u5199 SDK \u57FA\u7840\u8DEF\u5F84\uFF0C\u4E0D\u9644\u52A0 chat/completions\u3001responses \u6216 messages\u3002", children: (id) => (_jsx("input", { id: id, type: "url", value: draft.baseURL, onChange: (e) => patch({ baseURL: e.target.value }), required: true })) }), _jsx(Field, { label: "API Key", hint: connection
                    ? "已保存密钥不会回显，留空保留。"
                    : "由可信后端保护；也可使用宿主允许的 env:变量名。", children: (id) => (_jsx("input", { id: id, type: showKey ? "text" : "password", autoComplete: "off", value: draft.apiKey ?? "", onChange: (e) => patch({ apiKey: e.target.value }) })) }), _jsx("button", { type: "button", "aria-pressed": showKey, onClick: () => setShowKey((s) => !s), children: showKey ? "隐藏密钥" : "显示新输入密钥" }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: !!draft.confirmKeyDomainChange, onChange: (e) => patch({ confirmKeyDomainChange: e.target.checked }) }), "\u5730\u5740\u6216\u5382\u5546\u53D8\u5316\u540E\uFF0C\u6211\u5DF2\u786E\u8BA4\u5BC6\u94A5\u53EF\u7528\u4E8E\u65B0\u76EE\u6807"] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: draft.enabled, onChange: (e) => patch({ enabled: e.target.checked }) }), "\u542F\u7528\u8FDE\u63A5"] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: !!draft.clearDefault, onChange: (e) => patch({ clearDefault: e.target.checked }) }), "\u505C\u7528\u8FDE\u63A5\u65F6\u6E05\u7A7A\u5173\u8054\u9ED8\u8BA4\u65B9\u6848"] }), _jsx("button", { disabled: !!op.busy || !adapter, type: "submit", children: op.busy === "保存连接" ? "保存连接中…" : "保存连接" }), _jsxs("fieldset", { children: [_jsx("legend", { children: "\u6D4B\u8BD5\u5F53\u524D\u8868\u5355" }), _jsx(Field, { label: "\u6D4B\u8BD5\u6A21\u578B ID", children: (id) => (_jsx("input", { id: id, value: modelId, onChange: (e) => {
                                setModelId(e.target.value);
                                draftVersion.current++;
                                setTested(null);
                            } })) }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: fee, onChange: (e) => setFee(e.target.checked) }), "\u6211\u77E5\u9053\u6D4B\u8BD5\u4F1A\u8C03\u7528\u6A21\u578B\u5E76\u53EF\u80FD\u4EA7\u751F\u8D39\u7528"] }), _jsx("p", { children: "\u4F7F\u7528\u65E0\u4E1A\u52A1\u6570\u636E\u7684\u77ED\u6D88\u606F\uFF0C\u8F93\u51FA\u9884\u7B97\u6700\u591A 128 tokens\uFF1B\u601D\u8003\u6A21\u578B\u53EF\u80FD\u672A\u4EA7\u751F\u6700\u7EC8\u6B63\u6587\u3002" }), _jsx("button", { type: "button", disabled: !fee || !!op.busy || !adapter, onClick: () => void op.run("测试", async () => {
                            const version = draftVersion.current;
                            feedbackVersion.current = version;
                            const result = await test({ connection: input(), modelId });
                            if (draftVersion.current === version)
                                setTested(result);
                        }), children: "\u6D4B\u8BD5\u5F53\u524D\u8868\u5355" }), _jsx(TestFeedback, { value: tested })] }), _jsx(Feedback, { message: feedbackVersion.current === draftVersion.current ? op.message : "", failed: op.failed })] }));
}
