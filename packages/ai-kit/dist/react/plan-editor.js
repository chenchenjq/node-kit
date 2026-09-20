"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useState } from "react";
import { modelPresets } from "../catalog.js";
import { Feedback, Field, TestFeedback, useOperation } from "./shared.js";
export function PlanEditor({ connections, plan, save, test, className, }) {
    const first = connections[0], initialModel = modelPresets.find((p) => p.providerCode === first?.providerCode)
        ?.modelId ?? "";
    const [draft, setDraft] = useState(plan ?? {
        code: "",
        name: "",
        connectionId: first?.id ?? "",
        modelId: initialModel,
        enabled: true,
        isDefault: false,
        systemPrompt: null,
        parameters: {},
    }), op = useOperation();
    const [fee, setFee] = useState(false), [tested, setTested] = useState(null);
    const connection = connections.find((c) => c.id === draft.connectionId), presets = modelPresets.filter((p) => p.providerCode === connection?.providerCode), preset = presets.find((p) => p.modelId === draft.modelId);
    const draftVersion = useRef(0), feedbackVersion = useRef(0);
    const params = draft.parameters ?? {};
    const patch = (changes) => {
        draftVersion.current++;
        setTested(null);
        setDraft((d) => ({ ...d, ...changes }));
    };
    function parameter(name, value) {
        const updated = { ...params };
        if (value === "")
            delete updated[name];
        else if (name === "thinking")
            updated.thinking = value;
        else
            updated[name] = Number(value);
        patch({ parameters: updated });
    }
    return (_jsxs("form", { className: className ?? "ai-kit-form", noValidate: true, "aria-busy": !!op.busy, onSubmit: (e) => {
            e.preventDefault();
            void op.run("保存方案", () => {
                feedbackVersion.current = draftVersion.current;
                return save(draft);
            });
        }, children: [_jsx("h3", { children: plan ? "编辑方案" : "新增方案" }), _jsx(Field, { label: "\u65B9\u6848 code", hint: "\u521B\u5EFA\u540E\u4E0D\u53EF\u4FEE\u6539\uFF0C\u4E1A\u52A1\u901A\u8FC7\u6B64 code \u8C03\u7528\u3002", children: (id) => (_jsx("input", { id: id, value: draft.code, readOnly: !!plan, required: true, onChange: (e) => patch({ code: e.target.value }) })) }), _jsx(Field, { label: "\u65B9\u6848\u540D\u79F0", children: (id) => (_jsx("input", { id: id, value: draft.name, required: true, onChange: (e) => patch({ name: e.target.value }) })) }), _jsx(Field, { label: "\u8FDE\u63A5", children: (id) => (_jsx("select", { id: id, value: draft.connectionId, onChange: (e) => {
                        const c = connections.find((c) => c.id === e.target.value);
                        patch({
                            connectionId: e.target.value,
                            modelId: modelPresets.find((p) => p.providerCode === c?.providerCode)
                                ?.modelId ?? "",
                        });
                    }, children: connections.map((c) => (_jsxs("option", { value: c.id, children: [c.name, " \u00B7 ", c.providerCode, c.enabled ? "" : "（停用）"] }, c.id))) })) }), _jsx(Field, { label: "\u6A21\u578B\u9884\u8BBE", children: (id) => (_jsxs("select", { id: id, value: preset?.modelId ?? "", onChange: (e) => {
                        if (e.target.value)
                            patch({ modelId: e.target.value });
                    }, children: [_jsx("option", { value: "", children: "\u624B\u5DE5\u8F93\u5165" }), presets.map((p) => (_jsx("option", { value: p.modelId, children: p.name }, p.modelId)))] })) }), _jsx(Field, { label: "\u6A21\u578B ID", hint: "\u53EF\u624B\u5DE5\u8F93\u5165\uFF1B\u4FDD\u7559\u5927\u5C0F\u5199\u3002\u9884\u8BBE\u5916\u6A21\u578B\u9700\u5BBF\u4E3B\u6838\u5B9E\u53C2\u6570\u80FD\u529B\u3002", children: (id) => (_jsx("input", { id: id, value: draft.modelId, required: true, onChange: (e) => patch({ modelId: e.target.value }) })) }), _jsx(Field, { label: "\u9ED8\u8BA4 systemPrompt", hint: "\u53EA\u5141\u8BB8\u7BA1\u7406\u5458\u914D\u7F6E\u53EF\u4FE1\u7CFB\u7EDF\u6307\u4EE4\u3002", children: (id) => (_jsx("textarea", { className: "resize-none", id: id, style: { resize: "none" }, rows: 3, value: draft.systemPrompt ?? "", onChange: (e) => patch({ systemPrompt: e.target.value || null }) })) }), [
                "temperature",
                "topP",
                "maxOutputTokens",
                "timeoutMs",
                "maxRetries",
            ].map((name) => (_jsx(Field, { label: name, hint: name === "temperature" || name === "topP"
                    ? "留空不发送；仅核实支持的模型开放。"
                    : name === "maxOutputTokens"
                        ? "缺省有限预算，含推理 tokens；不会保证同量最终正文。"
                        : name === "timeoutMs"
                            ? "默认 60000"
                            : "默认 0；仅明确拒绝的限流可重试。", children: (id) => (_jsx("input", { id: id, type: "number", step: name === "temperature" || name === "topP" ? "any" : "1", disabled: params[name] === undefined &&
                        ((name === "temperature" && !preset?.temperature) ||
                            (name === "topP" && !preset?.topP)), value: params[name] ?? "", onChange: (e) => parameter(name, e.target.value) })) }, name))), (preset?.thinking || params.thinking !== undefined) && (_jsx(Field, { label: "\u601D\u8003\u9009\u9879", children: (id) => (_jsxs("select", { id: id, value: params.thinking ?? "", onChange: (e) => parameter("thinking", e.target.value), children: [_jsx("option", { value: "", children: "\u4F7F\u7528\u5382\u5546\u9ED8\u8BA4" }), _jsx("option", { value: "enabled", children: "\u542F\u7528\u601D\u8003" }), _jsx("option", { value: "disabled", children: "\u5173\u95ED\u601D\u8003" })] })) })), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: draft.enabled, onChange: (e) => patch({ enabled: e.target.checked }) }), "\u542F\u7528\u65B9\u6848"] }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: draft.isDefault, disabled: !draft.isDefault && (!draft.enabled || !connection?.enabled), onChange: (e) => patch({ isDefault: e.target.checked }) }), "\u8BBE\u4E3A\u9ED8\u8BA4\u65B9\u6848\uFF08\u66FF\u6362\u5F53\u524D\u9ED8\u8BA4\uFF09"] }), !connections.length && _jsx("p", { role: "status", children: "\u5148\u65B0\u589E\u8FDE\u63A5\uFF0C\u518D\u521B\u5EFA\u8C03\u7528\u65B9\u6848\u3002" }), _jsx("button", { type: "submit", disabled: !!op.busy || !connections.length, children: op.busy ? "保存方案中…" : "保存方案" }), _jsx("p", { children: "\u505C\u7528\u9ED8\u8BA4\u65B9\u6848\u524D\uFF0C\u8BF7\u660E\u786E\u53D6\u6D88\u9ED8\u8BA4\u6807\u8BB0\u6216\u91CD\u65B0\u6307\u5B9A\u9ED8\u8BA4\u3002" }), test && (_jsxs("fieldset", { children: [_jsx("legend", { children: "\u6D4B\u8BD5\u5F53\u524D\u65B9\u6848\u8868\u5355" }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: fee, onChange: (e) => setFee(e.target.checked) }), "\u786E\u8BA4\u5F53\u524D\u65B9\u6848\u6D4B\u8BD5\u53EF\u80FD\u4EA7\u751F\u8D39\u7528"] }), _jsx("button", { type: "button", disabled: !fee || !!op.busy, onClick: () => void op.run("测试当前方案", async () => {
                            const version = draftVersion.current;
                            feedbackVersion.current = version;
                            const result = await test(draft);
                            if (draftVersion.current === version)
                                setTested(result);
                        }), children: "\u6D4B\u8BD5\u5F53\u524D\u65B9\u6848" }), _jsx(TestFeedback, { value: tested })] })), _jsx(Feedback, { message: feedbackVersion.current === draftVersion.current ? op.message : "", failed: op.failed })] }));
}
