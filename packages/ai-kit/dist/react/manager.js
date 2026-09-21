"use client";
import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { ConnectionEditor } from "./connection-editor.js";
import { PlanEditor } from "./plan-editor.js";
import { Feedback, Field, TestFeedback, safeMessage, useOperation, } from "./shared.js";
export function AiManager(props) {
    const [data, setData] = useState(null), [connectionId, setConnectionId] = useState(""), [planCode, setPlanCode] = useState(""), [version, setVersion] = useState(0), [fee, setFee] = useState(false), [tested, setTested] = useState(null), [models, setModels] = useState([]), op = useOperation();
    const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState("");
    useEffect(() => {
        let active = true;
        setLoading(true);
        setLoadError("");
        void props
            .load()
            .then((next) => {
            if (active) {
                setData(next);
                setVersion((v) => v + 1);
            }
        }, (error) => {
            if (active)
                setLoadError(safeMessage(error));
        })
            .finally(() => {
            if (active)
                setLoading(false);
        });
        return () => {
            active = false;
        };
    }, [props.load]);
    async function reload() {
        setData(await props.load());
        setVersion((v) => v + 1);
        setTested(null);
    }
    if (!data)
        return (_jsxs("section", { "aria-label": "AI \u7BA1\u7406", children: [_jsx("p", { role: "status", children: loading || op.busy ? "正在读取配置…" : "配置尚未读取" }), _jsx(Feedback, { message: loadError || op.message, failed: !!loadError || op.failed }), _jsx("button", { onClick: () => void op.run("读取配置", reload), children: "\u91CD\u65B0\u52A0\u8F7D" })] }));
    const c = data.connections.find((c) => c.id === connectionId), p = data.plans.find((p) => p.code === planCode);
    return (_jsxs("section", { className: props.className ?? "ai-kit-manager", "aria-label": "AI \u7BA1\u7406", children: [_jsxs("header", { children: [_jsx("h2", { children: "AI \u8FDE\u63A5\u4E0E\u8C03\u7528\u65B9\u6848" }), _jsxs("p", { children: ["\u9ED8\u8BA4\u65B9\u6848\uFF1A", data.plans.find((p) => p.isDefault)?.code ?? "未设置"] }), _jsx("button", { disabled: !!op.busy, onClick: () => void op.run("重新加载", reload), children: "\u91CD\u65B0\u52A0\u8F7D\u914D\u7F6E" }), _jsx("button", { disabled: !!op.busy, onClick: () => void op.run("清空默认", async () => {
                            await props.setDefault(null);
                            await reload();
                        }), children: "\u6E05\u7A7A\u9ED8\u8BA4\u65B9\u6848" })] }), _jsxs("div", { className: "ai-kit-columns", children: [_jsxs("section", { "aria-label": "\u8FDE\u63A5\u7BA1\u7406", children: [_jsx(Field, { label: "\u9009\u62E9\u8FDE\u63A5", children: (id) => (_jsxs("select", { id: id, value: connectionId, onChange: (e) => {
                                        setConnectionId(e.target.value);
                                        setModels([]);
                                    }, children: [_jsx("option", { value: "", children: "\u65B0\u589E\u8FDE\u63A5" }), data.connections.map((c) => (_jsxs("option", { value: c.id, children: [c.name, " \u00B7 ", c.enabled ? "启用" : "停用", " \u00B7", " ", c.testedRevision === c.revision ? "已测试" : "待测试"] }, c.id)))] })) }), _jsx(ConnectionEditor, { connection: c, providers: data.providers, save: async (input) => {
                                    await props.saveConnection(input);
                                    await reload();
                                }, test: props.testDraft }, `${connectionId}:${version}`), props.refreshModels && c && (_jsxs(_Fragment, { children: [_jsx("button", { disabled: !!op.busy, onClick: () => void op.run("刷新模型", async () => setModels(await props.refreshModels(c.id))), children: "\u624B\u52A8\u5237\u65B0\u6A21\u578B\u5217\u8868" }), models.length > 0 && _jsxs("p", { children: ["\u53EF\u7528\u6A21\u578B\uFF1A", models.join("、")] })] }))] }), _jsxs("section", { "aria-label": "\u65B9\u6848\u7BA1\u7406", children: [_jsx(Field, { label: "\u9009\u62E9\u65B9\u6848", children: (id) => (_jsxs("select", { id: id, value: planCode, onChange: (e) => {
                                        setPlanCode(e.target.value);
                                        setTested(null);
                                    }, children: [_jsx("option", { value: "", children: "\u65B0\u589E\u65B9\u6848" }), data.plans.map((p) => (_jsxs("option", { value: p.code, children: [p.name, " \u00B7 ", p.code, p.isDefault ? "（默认）" : ""] }, p.code)))] })) }), _jsx(PlanEditor, { plan: p, connections: data.connections, save: async (input) => {
                                    await props.savePlan(input);
                                    await reload();
                                }, test: async (input) => {
                                    const conn = data.connections.find((c) => c.id === input.connectionId);
                                    if (!conn)
                                        throw { code: "NOT_FOUND" };
                                    return props.testDraft({
                                        connection: {
                                            id: conn.id,
                                            revision: conn.revision,
                                            name: conn.name,
                                            providerCode: conn.providerCode,
                                            protocol: conn.protocol,
                                            baseURL: conn.baseURL,
                                            enabled: conn.enabled,
                                        },
                                        modelId: input.modelId,
                                        ...(input.parameters ? { parameters: input.parameters } : {}),
                                    });
                                } }, `${planCode}:${version}`), p && (_jsxs("fieldset", { children: [_jsx("legend", { children: "\u6D4B\u8BD5\u5DF2\u4FDD\u5B58\u65B9\u6848" }), _jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: fee, onChange: (e) => setFee(e.target.checked) }), "\u786E\u8BA4\u53EF\u80FD\u4EA7\u751F\u8D39\u7528"] }), _jsx("button", { disabled: !fee || !!op.busy, onClick: () => void op.run("测试已保存方案", async () => setTested(await props.testPlan(p.code))), children: "\u6D4B\u8BD5\u5DF2\u4FDD\u5B58\u65B9\u6848" }), _jsx(TestFeedback, { value: tested })] }))] })] }), _jsx(Feedback, { message: op.message, failed: op.failed })] }));
}
