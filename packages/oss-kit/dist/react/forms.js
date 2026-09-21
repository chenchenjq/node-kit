"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useState } from "react";
const styles = `
.oss-kit { --oss-bg:#fff;--oss-text:#17202a;--oss-muted:#667085;--oss-line:#d8dee7;--oss-soft:#f5f7fa;--oss-accent:#215b8f;--oss-accent-hover:#174873;--oss-danger:#b42318;--oss-success:#18704a; box-sizing:border-box;width:min(100%,48rem);border:1px solid var(--oss-line);border-radius:.75rem;background:var(--oss-bg);color:var(--oss-text);box-shadow:0 .75rem 2rem rgba(23,32,42,.08);padding:1.5rem;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:.9375rem;line-height:1.5 }
.oss-kit *,.oss-kit *:before,.oss-kit *:after{box-sizing:border-box}.oss-kit__header{margin-bottom:1.25rem}.oss-kit__title{margin:0;font-size:1.35rem;line-height:1.25;font-weight:650;letter-spacing:-.015em}.oss-kit__subtitle{margin:.3rem 0 0;color:var(--oss-muted);font-size:.875rem}.oss-kit__form,.oss-kit__fields{display:grid;gap:1rem}.oss-kit__fields{grid-template-columns:repeat(2,minmax(0,1fr))}.oss-kit__field{display:grid;gap:.375rem}.oss-kit__label{font-weight:600}.oss-kit__hint{margin:0;color:var(--oss-muted);font-size:.8rem}.oss-kit__input,.oss-kit__select,.oss-kit__textarea{width:100%;min-height:2.65rem;border:1px solid var(--oss-line);border-radius:.5rem;background:var(--oss-bg);color:var(--oss-text);padding:.62rem .72rem;font:inherit}.oss-kit__textarea{min-height:5.5rem}.oss-kit__input:focus-visible,.oss-kit__select:focus-visible,.oss-kit__textarea:focus-visible,.oss-kit__button:focus-visible{outline:3px solid rgba(33,91,143,.24);outline-offset:2px}.oss-kit__button{min-height:2.65rem;border:1px solid transparent;border-radius:.5rem;padding:.58rem .8rem;font:inherit;font-weight:650;line-height:1.25;cursor:pointer}.oss-kit__button:disabled{cursor:not-allowed;opacity:.58}.oss-kit__button--primary{background:var(--oss-accent);color:#fff}.oss-kit__button--primary:hover:not(:disabled){background:var(--oss-accent-hover)}.oss-kit__button--secondary{border-color:var(--oss-line);background:var(--oss-soft);color:var(--oss-text)}.oss-kit__button--link{min-height:auto;border:0;background:transparent;color:var(--oss-accent);padding:.2rem;font-weight:600}.oss-kit__button--link:hover:not(:disabled){text-decoration:underline}.oss-kit .resize-none{resize:none}.oss-kit__actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem}.oss-kit__message{min-height:1.4rem;margin:0;font-size:.875rem}.oss-kit__message--error{color:var(--oss-danger)}.oss-kit__message--success{color:var(--oss-success)}.oss-kit__list{display:grid;gap:.5rem;margin:0 0 1rem;padding:0;list-style:none}.oss-kit__row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;border:1px solid var(--oss-line);border-radius:.5rem;padding:.7rem}.oss-kit__row[aria-current="true"]{border-color:var(--oss-accent);background:#f4f8fc}.oss-kit__row-meta{color:var(--oss-muted);font-size:.8rem}.oss-kit__check{display:flex;align-items:center;gap:.45rem}.oss-kit__result{border-left:3px solid var(--oss-line);padding-left:.7rem}.oss-kit__result--failed{border-color:var(--oss-danger)}.oss-kit__result--passed{border-color:var(--oss-success)}.oss-kit__pagination{display:flex;align-items:center;gap:.5rem;margin-bottom:1rem}@media(max-width:34rem){.oss-kit{padding:1.15rem}.oss-kit__fields{grid-template-columns:1fr}.oss-kit__row{align-items:flex-start;flex-direction:column}}@media(prefers-reduced-motion:reduce){.oss-kit *{scroll-behavior:auto!important}}
`;
function messageFrom(error) {
    return error instanceof Error
        ? error.message
        : "The request did not complete. Try again.";
}
function lines(value) {
    return value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
}
function asNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function storageDefaults() {
    return {
        name: "",
        region: "",
        bucket: "",
        endpoint: "",
        access: "private",
        publicDomain: "",
        enabled: true,
    };
}
function storageInputFromSummary(record) {
    return {
        name: record.name,
        region: record.region,
        bucket: record.bucket,
        endpoint: record.endpoint,
        access: record.access,
        publicDomain: record.publicDomain ?? "",
        enabled: record.enabled,
    };
}
function strategyDefaults() {
    return {
        code: "",
        name: "",
        description: "",
        storageConfigId: null,
        prefix: "",
        dateDirectory: "year-month-day",
        naming: "uuid",
        allowedExtensions: [],
        allowedMimeTypes: [],
        maxSizeBytes: 10 * 1024 * 1024,
        enabled: true,
    };
}
function Messages({ error, status }) {
    return (_jsxs("div", { "aria-live": "polite", "aria-atomic": "true", children: [error && (_jsx("p", { className: "oss-kit__message oss-kit__message--error", role: "alert", children: error })), status && (_jsx("p", { className: "oss-kit__message oss-kit__message--success", role: "status", children: status }))] }));
}
export function StorageManager({ list, save, test, setDefault, setEnabled, className, }) {
    const [records, setRecords] = useState([]);
    const [selected, setSelected] = useState(null);
    const [input, setInput] = useState(storageDefaults);
    const [keyId, setKeyId] = useState("");
    const [secret, setSecret] = useState("");
    const [token, setToken] = useState("");
    const [clearStsToken, setClearStsToken] = useState(false);
    const [showSecret, setShowSecret] = useState(false);
    const [testPrefix, setTestPrefix] = useState("oss-kit-test");
    const [result, setResult] = useState(null);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(null);
    const [page, setPage] = useState(0);
    const titleId = useId();
    const refresh = async () => {
        try {
            const next = await list();
            setRecords(next);
            if (selected) {
                const updated = next.find((record) => record.id === selected.id);
                if (updated) {
                    setSelected(updated);
                    setInput(storageInputFromSummary(updated));
                }
            }
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
    };
    useEffect(() => {
        void refresh();
    }, []); // callbacks are host-owned and expected stable
    const choose = (record) => {
        if (busy)
            return;
        setSelected(record);
        setInput(storageInputFromSummary(record));
        setKeyId("");
        setSecret("");
        setToken("");
        setClearStsToken(false);
        setResult(null);
        setError("");
        setStatus("");
    };
    const reset = () => {
        if (busy)
            return;
        setSelected(null);
        setInput(storageDefaults());
        setKeyId("");
        setSecret("");
        setToken("");
        setClearStsToken(false);
        setResult(null);
        setError("");
        setStatus("");
    };
    const credentials = () => keyId || secret || token || clearStsToken
        ? {
            accessKeyId: keyId.trim(),
            accessKeySecret: secret,
            ...(token.trim() ? { stsToken: token.trim() } : {}),
            ...(clearStsToken ? { clearStsToken: true } : {}),
        }
        : undefined;
    const validate = () => {
        if (!input.name.trim() || !input.region.trim() || !input.bucket.trim()) {
            setError("Name, region, and bucket are required.");
            return false;
        }
        if (!selected && (!keyId.trim() || !secret)) {
            setError("An access key ID and secret are required for a new storage configuration.");
            return false;
        }
        if (clearStsToken && token.trim()) {
            setError("Clear the entered STS token before requesting its removal.");
            return false;
        }
        return true;
    };
    const submit = async (event) => {
        event.preventDefault();
        if (busy || !validate())
            return;
        setBusy("save");
        setError("");
        try {
            await save({
                ...input,
                name: input.name.trim(),
                region: input.region.trim(),
                bucket: input.bucket.trim(),
                endpoint: input.endpoint?.trim() ?? "",
                publicDomain: input.publicDomain?.trim() || null,
            }, credentials(), selected?.id);
            setStatus("Storage configuration saved.");
            setKeyId("");
            setSecret("");
            setToken("");
            setClearStsToken(false);
            await refresh();
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const runTest = async () => {
        if (busy || !validate())
            return;
        const nextCredentials = credentials();
        setBusy("test");
        setError("");
        setResult(null);
        try {
            const next = await test({
                input,
                ...(nextCredentials ? { credentials: nextCredentials } : {}),
                ...(selected ? { storageConfigId: selected.id } : {}),
                prefix: testPrefix.trim(),
            });
            setResult(next);
            setStatus("Connection test completed.");
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const changeEnabled = async (record) => {
        if (busy)
            return;
        setBusy("save");
        setError("");
        try {
            await setEnabled(record.id, !record.enabled);
            await refresh();
            setStatus(record.enabled ? "Storage disabled." : "Storage enabled.");
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const visible = records.slice(page * 10, page * 10 + 10);
    return (_jsxs("section", { className: `oss-kit ${className ?? ""}`.trim(), "aria-labelledby": titleId, "aria-busy": busy !== null, children: [_jsx("style", { children: styles }), _jsxs("header", { className: "oss-kit__header", children: [_jsx("h2", { className: "oss-kit__title", id: titleId, children: "Storage configurations" }), _jsx("p", { className: "oss-kit__subtitle", children: "Credentials are sent only to your host callback and are never listed here." })] }), _jsx("ul", { className: "oss-kit__list", "aria-label": "Storage configurations", children: visible.map((record) => (_jsxs("li", { className: "oss-kit__row", "aria-current": selected?.id === record.id || undefined, children: [_jsxs("span", { children: [_jsx("strong", { children: record.name }), _jsx("br", {}), _jsxs("span", { className: "oss-kit__row-meta", children: [record.region, " \u00B7 ", record.bucket, " \u00B7 ", record.access, " \u00B7", " ", record.enabled ? "enabled" : "disabled", record.isDefault ? " · default" : ""] })] }), _jsxs("span", { className: "oss-kit__actions", children: [_jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null, onClick: () => choose(record), children: "Edit" }), _jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null || record.isDefault || !record.enabled, onClick: () => void (async () => {
                                        setBusy("default");
                                        try {
                                            await setDefault(record.id);
                                            await refresh();
                                            setStatus("Default storage updated.");
                                        }
                                        catch (caught) {
                                            setError(messageFrom(caught));
                                        }
                                        finally {
                                            setBusy(null);
                                        }
                                    })(), children: "Make default" }), _jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null, onClick: () => void changeEnabled(record), children: record.enabled ? "Disable" : "Enable" })] })] }, record.id))) }), records.length > 10 && (_jsxs("nav", { className: "oss-kit__pagination", "aria-label": "Storage pages", children: [_jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null || page === 0, onClick: () => setPage(page - 1), children: "Previous" }), _jsxs("span", { children: ["Page ", page + 1, " of ", Math.ceil(records.length / 10)] }), _jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null || (page + 1) * 10 >= records.length, onClick: () => setPage(page + 1), children: "Next" })] })), _jsx("div", { className: "oss-kit__actions", children: _jsx("button", { className: "oss-kit__button oss-kit__button--link", type: "button", disabled: busy !== null, onClick: reset, children: "New storage configuration" }) }), _jsx("form", { className: "oss-kit__form", onSubmit: (event) => void submit(event), noValidate: true, children: _jsxs("fieldset", { disabled: busy !== null, style: { border: 0, margin: 0, minWidth: 0, padding: 0 }, children: [_jsxs("div", { className: "oss-kit__fields", children: [_jsx(Field, { label: "Name", value: input.name, onChange: (name) => setInput({ ...input, name }) }), _jsx(Field, { label: "Region", value: input.region, disabled: !!selected, onChange: (region) => setInput({ ...input, region }) }), _jsx(Field, { label: "Bucket", value: input.bucket, disabled: !!selected, onChange: (bucket) => setInput({ ...input, bucket }) }), _jsx(Field, { label: "Endpoint (optional)", value: input.endpoint ?? "", onChange: (endpoint) => setInput({ ...input, endpoint }) }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Access" }), _jsxs("select", { className: "oss-kit__select", value: input.access, disabled: !!selected?.used, onChange: (event) => setInput({
                                                ...input,
                                                access: event.target.value,
                                            }), children: [_jsx("option", { value: "private", children: "Private" }), _jsx("option", { value: "public", children: "Public" })] })] }), _jsx(Field, { label: "Public domain (optional)", value: input.publicDomain ?? "", onChange: (publicDomain) => setInput({ ...input, publicDomain }) })] }), _jsxs("label", { className: "oss-kit__check", children: [_jsx("input", { type: "checkbox", checked: input.enabled !== false, onChange: (event) => setInput({ ...input, enabled: event.target.checked }) }), "Enabled"] }), _jsxs("div", { className: "oss-kit__fields", children: [_jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Access key ID" }), _jsx("input", { className: "oss-kit__input", type: showSecret ? "text" : "password", autoComplete: "off", "aria-label": "Access key ID", value: keyId, onChange: (event) => setKeyId(event.target.value) }), selected && (_jsx("span", { className: "oss-kit__hint", children: "Leave credential fields empty to keep saved credentials." }))] }), selected && (_jsxs("label", { className: "oss-kit__check", children: [_jsx("input", { type: "checkbox", checked: clearStsToken, onChange: (event) => setClearStsToken(event.target.checked) }), "Clear saved STS token"] })), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Access key secret" }), _jsxs("span", { className: "oss-kit__actions", children: [_jsx("input", { className: "oss-kit__input", type: showSecret ? "text" : "password", autoComplete: "new-password", "aria-label": "Access key secret", value: secret, onChange: (event) => setSecret(event.target.value) }), _jsx("button", { className: "oss-kit__button oss-kit__button--link", type: "button", onClick: () => setShowSecret(!showSecret), "aria-label": showSecret
                                                        ? "Hide access key secret"
                                                        : "Show access key secret", children: showSecret ? "Hide" : "Show" })] })] }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "STS token (optional)" }), _jsx("input", { className: "oss-kit__input", type: showSecret ? "text" : "password", autoComplete: "off", "aria-label": "STS token (optional)", value: token, onChange: (event) => setToken(event.target.value) })] }), _jsx(Field, { label: "Admin test prefix", value: testPrefix, onChange: setTestPrefix, hint: "Use an isolated prefix your administrator authorizes for test cleanup." })] }), _jsxs("div", { className: "oss-kit__actions", children: [_jsx("button", { className: "oss-kit__button oss-kit__button--primary", disabled: busy !== null, children: busy === "save" ? "Saving…" : "Save storage" }), _jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null, onClick: () => void runTest(), children: busy === "test" ? "Testing…" : "Test connection" })] }), _jsx(Messages, { error: error, status: status }), result && _jsx(TestResult, { result: result })] }) })] }));
}
function Field({ label, value, onChange, disabled, hint, autoComplete, }) {
    const id = useId();
    const hintId = useId();
    return (_jsxs("label", { className: "oss-kit__field", htmlFor: id, children: [_jsx("span", { className: "oss-kit__label", children: label }), _jsx("input", { className: "oss-kit__input", id: id, value: value, disabled: disabled, autoComplete: autoComplete, onChange: (event) => onChange(event.target.value), "aria-describedby": hint ? hintId : undefined }), hint && (_jsx("span", { className: "oss-kit__hint", id: hintId, children: hint }))] }));
}
function TestResult({ result }) {
    const entries = Object.entries({
        upload: result.upload,
        read: result.read,
        delete: result.delete,
    });
    return (_jsxs("div", { "aria-label": "Connection test outcome", children: [_jsxs("p", { className: "oss-kit__hint", children: ["Test object: ", result.objectKey] }), entries.map(([name, step]) => (_jsxs("p", { className: `oss-kit__result oss-kit__result--${step.status}`, children: [_jsxs("strong", { children: [name, ": ", step.status] }), step.error && ` — ${step.error.message}`] }, name))), result.cleanupRequired && (_jsx("p", { className: "oss-kit__message oss-kit__message--error", role: "alert", children: "Cleanup could not be confirmed. Remove the test object manually." }))] }));
}
export function StrategyEditor({ listStorage, listStrategies, save, preview, className, }) {
    const [storage, setStorage] = useState([]);
    const [strategies, setStrategies] = useState([]);
    const [selected, setSelected] = useState(null);
    const [input, setInput] = useState(strategyDefaults);
    const [extensionsText, setExtensionsText] = useState("");
    const [mimeTypesText, setMimeTypesText] = useState("");
    const [maxSizeText, setMaxSizeText] = useState(String(10 * 1024 * 1024));
    const [originalName, setOriginalName] = useState("example.png");
    const [previewKey, setPreviewKey] = useState("");
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(null);
    const titleId = useId();
    const refresh = async () => {
        try {
            const [nextStorage, nextStrategies] = await Promise.all([
                listStorage(),
                listStrategies(),
            ]);
            setStorage(nextStorage);
            setStrategies(nextStrategies);
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
    };
    useEffect(() => {
        void refresh();
    }, []);
    useEffect(() => {
        setPreviewKey("");
    }, [extensionsText, input, maxSizeText, mimeTypesText, originalName]);
    const choose = (strategy) => {
        if (busy)
            return;
        setSelected(strategy);
        setInput({ ...strategy });
        setExtensionsText(strategy.allowedExtensions.join("\n"));
        setMimeTypesText(strategy.allowedMimeTypes.join("\n"));
        setMaxSizeText(String(strategy.maxSizeBytes));
        setPreviewKey("");
        setError("");
        setStatus("");
    };
    const reset = () => {
        if (busy)
            return;
        setSelected(null);
        setInput(strategyDefaults());
        setExtensionsText("");
        setMimeTypesText("");
        setMaxSizeText(String(10 * 1024 * 1024));
        setPreviewKey("");
        setError("");
        setStatus("");
    };
    const submit = async (event) => {
        event.preventDefault();
        if (busy)
            return;
        if (!input.code.trim() || !input.name.trim()) {
            setError("Code and name are required.");
            return;
        }
        const maxSizeBytes = asNumber(maxSizeText);
        if (!maxSizeBytes) {
            setError("Enter a positive maximum file size in bytes.");
            return;
        }
        setBusy("save");
        setError("");
        try {
            await save({
                ...input,
                code: input.code.trim(),
                name: input.name.trim(),
                prefix: input.prefix.trim(),
                allowedExtensions: lines(extensionsText).map((item) => item.toLowerCase()),
                allowedMimeTypes: lines(mimeTypesText).map((item) => item.toLowerCase()),
                maxSizeBytes,
            });
            setStatus("Strategy saved.");
            await refresh();
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const runPreview = async () => {
        if (busy || !originalName.trim())
            return;
        const maxSizeBytes = asNumber(maxSizeText);
        if (!maxSizeBytes) {
            setError("Enter a positive maximum file size in bytes.");
            return;
        }
        setBusy("test");
        setError("");
        try {
            setPreviewKey(await preview({
                ...input,
                allowedExtensions: lines(extensionsText),
                allowedMimeTypes: lines(mimeTypesText),
                maxSizeBytes,
            }, originalName.trim()));
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
        }
    };
    return (_jsxs("section", { className: `oss-kit ${className ?? ""}`.trim(), "aria-labelledby": titleId, "aria-busy": busy !== null, children: [_jsx("style", { children: styles }), _jsxs("header", { className: "oss-kit__header", children: [_jsx("h2", { className: "oss-kit__title", id: titleId, children: "Upload strategies" }), _jsx("p", { className: "oss-kit__subtitle", children: "Preview runs the host\u2019s server-side naming rule." })] }), _jsx("ul", { className: "oss-kit__list", "aria-label": "Upload strategies", children: strategies.map((strategy) => (_jsxs("li", { className: "oss-kit__row", "aria-current": selected?.code === strategy.code || undefined, children: [_jsxs("span", { children: [_jsx("strong", { children: strategy.name }), _jsx("br", {}), _jsxs("span", { className: "oss-kit__row-meta", children: [strategy.code, " \u00B7 ", strategy.enabled ? "enabled" : "disabled"] })] }), _jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null, onClick: () => choose(strategy), children: "Edit" })] }, strategy.code))) }), _jsx("button", { className: "oss-kit__button oss-kit__button--link", type: "button", disabled: busy !== null, onClick: reset, children: "New strategy" }), _jsx("form", { className: "oss-kit__form", onSubmit: (event) => void submit(event), noValidate: true, children: _jsxs("fieldset", { disabled: busy !== null, style: { border: 0, margin: 0, minWidth: 0, padding: 0 }, children: [_jsxs("div", { className: "oss-kit__fields", children: [_jsx(Field, { label: "Code", value: input.code, disabled: !!selected, onChange: (code) => setInput({ ...input, code }) }), _jsx(Field, { label: "Name", value: input.name, onChange: (name) => setInput({ ...input, name }) }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Description" }), _jsx("textarea", { className: "oss-kit__textarea resize-none", value: input.description, onChange: (event) => setInput({ ...input, description: event.target.value }) })] }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Storage binding" }), _jsxs("select", { className: "oss-kit__select", value: input.storageConfigId ?? "", onChange: (event) => setInput({
                                                ...input,
                                                storageConfigId: event.target.value || null,
                                            }), children: [_jsx("option", { value: "", children: "Default storage" }), storage.map((item) => (_jsx("option", { value: item.id, children: item.name }, item.id)))] })] }), _jsx(Field, { label: "Object prefix", value: input.prefix, onChange: (prefix) => setInput({ ...input, prefix }) }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Date directory" }), _jsxs("select", { className: "oss-kit__select", value: input.dateDirectory, onChange: (event) => setInput({
                                                ...input,
                                                dateDirectory: event.target
                                                    .value,
                                            }), children: [_jsx("option", { value: "fixed", children: "Fixed" }), _jsx("option", { value: "year-month", children: "Year/month" }), _jsx("option", { value: "year-month-day", children: "Year/month/day" })] })] }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Naming" }), _jsxs("select", { className: "oss-kit__select", value: input.naming, onChange: (event) => setInput({
                                                ...input,
                                                naming: event.target.value,
                                            }), children: [_jsx("option", { value: "uuid", children: "UUID" }), _jsx("option", { value: "timestamp-random", children: "Timestamp + random" }), _jsx("option", { value: "original-random", children: "Original + random" })] })] }), _jsx(Field, { label: "Max size in bytes", value: maxSizeText, onChange: setMaxSizeText })] }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Allowed extensions" }), _jsx("textarea", { className: "oss-kit__textarea resize-none", value: extensionsText, onChange: (event) => setExtensionsText(event.target.value), placeholder: "png\\njpg" })] }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Allowed MIME types" }), _jsx("textarea", { className: "oss-kit__textarea resize-none", value: mimeTypesText, onChange: (event) => setMimeTypesText(event.target.value), placeholder: "image/png\\nimage/jpeg" })] }), _jsxs("label", { className: "oss-kit__check", children: [_jsx("input", { type: "checkbox", checked: input.enabled !== false, onChange: (event) => setInput({ ...input, enabled: event.target.checked }) }), "Enabled"] }), _jsx("div", { className: "oss-kit__actions", children: _jsx("button", { className: "oss-kit__button oss-kit__button--primary", disabled: busy !== null, children: busy === "save" ? "Saving…" : "Save strategy" }) }), _jsxs("div", { className: "oss-kit__fields", children: [_jsx(Field, { label: "Original file name for preview", value: originalName, onChange: setOriginalName }), _jsxs("div", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Server preview" }), _jsx("output", { className: "oss-kit__input", children: previewKey || "No preview yet" })] })] }), _jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null, onClick: () => void runPreview(), children: busy === "test" ? "Previewing…" : "Preview object key" }), _jsx(Messages, { error: error, status: status })] }) })] }));
}
export function UploadExample({ listStrategies, upload, getLink, className, }) {
    const [strategies, setStrategies] = useState([]);
    const [code, setCode] = useState("");
    const [file, setFile] = useState(null);
    const [reference, setReference] = useState(null);
    const [link, setLink] = useState(null);
    const [error, setError] = useState("");
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(null);
    const titleId = useId();
    useEffect(() => {
        void (async () => {
            try {
                const next = await listStrategies();
                setStrategies(next.filter((strategy) => strategy.enabled));
            }
            catch (caught) {
                setError(messageFrom(caught));
            }
        })();
    }, []);
    const submit = async (event) => {
        event.preventDefault();
        if (busy)
            return;
        if (!code || !file) {
            setError("Choose an enabled strategy and a file.");
            return;
        }
        setBusy("upload");
        setError("");
        setStatus("");
        setReference(null);
        setLink(null);
        try {
            const next = await upload(code, file);
            setReference(next);
            setStatus("Upload completed. Request a link through your trusted host.");
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
        }
    };
    const requestLink = async () => {
        if (!reference || busy)
            return;
        setBusy("link");
        setError("");
        try {
            const next = await getLink(reference);
            setLink(next);
            setStatus("Access link created.");
        }
        catch (caught) {
            setError(messageFrom(caught));
        }
        finally {
            setBusy(null);
        }
    };
    return (_jsxs("section", { className: `oss-kit ${className ?? ""}`.trim(), "aria-labelledby": titleId, "aria-busy": busy !== null, children: [_jsx("style", { children: styles }), _jsxs("header", { className: "oss-kit__header", children: [_jsx("h2", { className: "oss-kit__title", id: titleId, children: "Upload a file" }), _jsx("p", { className: "oss-kit__subtitle", children: "This reference calls your trusted host; it never claims an upload succeeded before the host responds." })] }), _jsxs("form", { className: "oss-kit__form", onSubmit: (event) => void submit(event), noValidate: true, children: [_jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "Strategy" }), _jsxs("select", { className: "oss-kit__select", value: code, onChange: (event) => setCode(event.target.value), children: [_jsx("option", { value: "", children: "Choose a strategy" }), strategies.map((strategy) => (_jsx("option", { value: strategy.code, children: strategy.name }, strategy.code)))] })] }), _jsxs("label", { className: "oss-kit__field", children: [_jsx("span", { className: "oss-kit__label", children: "File" }), _jsx("input", { className: "oss-kit__input", type: "file", onChange: (event) => setFile(event.target.files?.[0] ?? null) }), file && (_jsxs("span", { className: "oss-kit__hint", children: [file.name, " \u00B7 ", file.size.toLocaleString(), " bytes"] }))] }), _jsx("button", { className: "oss-kit__button oss-kit__button--primary", disabled: busy !== null, children: busy === "upload" ? "Uploading…" : "Upload file" }), _jsx(Messages, { error: error, status: status }), reference && (_jsxs("div", { className: "oss-kit__result", children: [_jsxs("p", { children: [_jsx("strong", { children: "Uploaded:" }), " ", reference.originalName] }), _jsx("button", { className: "oss-kit__button oss-kit__button--secondary", type: "button", disabled: busy !== null, onClick: () => void requestLink(), children: busy === "link" ? "Creating link…" : "Get access link" })] })), link && (_jsxs("div", { className: "oss-kit__result oss-kit__result--passed", children: [_jsx("a", { href: link.url, children: "Open transient access link" }), _jsxs("p", { className: "oss-kit__hint", children: [link.access, " access", link.expiresAt
                                        ? ` · expires ${link.expiresAt}`
                                        : " · no expiry returned"] })] }))] })] }));
}
