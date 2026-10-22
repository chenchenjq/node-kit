"use client";

import { useEffect, useId, useState, type FormEvent } from "react";

import type {
  AccessLink,
  ConnectionTestResult,
  Credentials,
  CredentialUpdate,
  FileReference,
  StorageInput,
  StorageSummary,
  Strategy,
  StrategyInput,
} from "../types.js";

type Busy = "save" | "test" | "default" | "upload" | "link" | null;
type StrategyDraft = StrategyInput & {
  storageConfigId: string | null;
  dateDirectory: NonNullable<StrategyInput["dateDirectory"]>;
  naming: NonNullable<StrategyInput["naming"]>;
  maxSizeBytes: number;
  enabled: boolean;
};
/** Browser-safe representation of the server's admin test request. */
export interface StorageTestInput {
  input: StorageInput;
  credentials?: CredentialUpdate;
  storageConfigId?: string;
  prefix: string;
}

export interface StorageManagerProps {
  list: () => Promise<StorageSummary[]>;
  save: (
    input: StorageInput,
    credentials?: CredentialUpdate,
    id?: string,
  ) => Promise<void>;
  test: (request: StorageTestInput) => Promise<ConnectionTestResult>;
  setDefault: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  className?: string;
}

export interface StrategyEditorProps {
  listStorage: () => Promise<StorageSummary[]>;
  listStrategies: () => Promise<Strategy[]>;
  save: (input: StrategyInput) => Promise<void>;
  preview: (input: StrategyInput, originalName: string) => Promise<string>;
  className?: string;
}

export interface UploadExampleProps {
  listStrategies: () => Promise<Strategy[]>;
  upload: (code: string, file: File) => Promise<FileReference>;
  getLink: (reference: FileReference) => Promise<AccessLink>;
  className?: string;
}

const styles = `
.oss-kit { --oss-bg:#fff;--oss-text:#17202a;--oss-muted:#667085;--oss-line:#d8dee7;--oss-soft:#f5f7fa;--oss-accent:#215b8f;--oss-accent-hover:#174873;--oss-danger:#b42318;--oss-success:#18704a; box-sizing:border-box;width:min(100%,48rem);border:1px solid var(--oss-line);border-radius:.75rem;background:var(--oss-bg);color:var(--oss-text);box-shadow:0 .75rem 2rem rgba(23,32,42,.08);padding:1.5rem;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:.9375rem;line-height:1.5 }
.oss-kit *,.oss-kit *:before,.oss-kit *:after{box-sizing:border-box}.oss-kit__header{margin-bottom:1.25rem}.oss-kit__title{margin:0;font-size:1.35rem;line-height:1.25;font-weight:650;letter-spacing:-.015em}.oss-kit__subtitle{margin:.3rem 0 0;color:var(--oss-muted);font-size:.875rem}.oss-kit__form,.oss-kit__fields{display:grid;gap:1rem}.oss-kit__fields{grid-template-columns:repeat(2,minmax(0,1fr))}.oss-kit__field{display:grid;gap:.375rem}.oss-kit__label{font-weight:600}.oss-kit__hint{margin:0;color:var(--oss-muted);font-size:.8rem}.oss-kit__input,.oss-kit__select,.oss-kit__textarea{width:100%;min-height:2.65rem;border:1px solid var(--oss-line);border-radius:.5rem;background:var(--oss-bg);color:var(--oss-text);padding:.62rem .72rem;font:inherit}.oss-kit__textarea{min-height:5.5rem}.oss-kit__input:focus-visible,.oss-kit__select:focus-visible,.oss-kit__textarea:focus-visible,.oss-kit__button:focus-visible{outline:3px solid rgba(33,91,143,.24);outline-offset:2px}.oss-kit__button{min-height:2.65rem;border:1px solid transparent;border-radius:.5rem;padding:.58rem .8rem;font:inherit;font-weight:650;line-height:1.25;cursor:pointer}.oss-kit__button:disabled{cursor:not-allowed;opacity:.58}.oss-kit__button--primary{background:var(--oss-accent);color:#fff}.oss-kit__button--primary:hover:not(:disabled){background:var(--oss-accent-hover)}.oss-kit__button--secondary{border-color:var(--oss-line);background:var(--oss-soft);color:var(--oss-text)}.oss-kit__button--link{min-height:auto;border:0;background:transparent;color:var(--oss-accent);padding:.2rem;font-weight:600}.oss-kit__button--link:hover:not(:disabled){text-decoration:underline}.oss-kit .resize-none{resize:none}.oss-kit__actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem}.oss-kit__message{min-height:1.4rem;margin:0;font-size:.875rem}.oss-kit__message--error{color:var(--oss-danger)}.oss-kit__message--success{color:var(--oss-success)}.oss-kit__list{display:grid;gap:.5rem;margin:0 0 1rem;padding:0;list-style:none}.oss-kit__row{display:flex;align-items:center;justify-content:space-between;gap:.75rem;border:1px solid var(--oss-line);border-radius:.5rem;padding:.7rem}.oss-kit__row[aria-current="true"]{border-color:var(--oss-accent);background:#f4f8fc}.oss-kit__row-meta{color:var(--oss-muted);font-size:.8rem}.oss-kit__check{display:flex;align-items:center;gap:.45rem}.oss-kit__result{border-left:3px solid var(--oss-line);padding-left:.7rem}.oss-kit__result--failed{border-color:var(--oss-danger)}.oss-kit__result--passed{border-color:var(--oss-success)}.oss-kit__pagination{display:flex;align-items:center;gap:.5rem;margin-bottom:1rem}@media(max-width:34rem){.oss-kit{padding:1.15rem}.oss-kit__fields{grid-template-columns:1fr}.oss-kit__row{align-items:flex-start;flex-direction:column}}@media(prefers-reduced-motion:reduce){.oss-kit *{scroll-behavior:auto!important}}
`;

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request did not complete. Try again.";
}
function lines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function asNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function storageDefaults(): StorageInput {
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
function storageInputFromSummary(record: StorageSummary): StorageInput {
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
function strategyDefaults(): StrategyDraft {
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

function Messages({ error, status }: { error: string; status: string }) {
  return (
    <div aria-live="polite" aria-atomic="true">
      {error && (
        <p className="oss-kit__message oss-kit__message--error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="oss-kit__message oss-kit__message--success" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

export function StorageManager({
  list,
  save,
  test,
  setDefault,
  setEnabled,
  className,
}: StorageManagerProps) {
  const [records, setRecords] = useState<StorageSummary[]>([]);
  const [selected, setSelected] = useState<StorageSummary | null>(null);
  const [input, setInput] = useState<StorageInput>(storageDefaults);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [clearStsToken, setClearStsToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [testPrefix, setTestPrefix] = useState("oss-kit-test");
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
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
    } catch (caught) {
      setError(messageFrom(caught));
    }
  };
  useEffect(() => {
    void refresh();
  }, []); // callbacks are host-owned and expected stable
  const choose = (record: StorageSummary) => {
    if (busy) return;
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
    if (busy) return;
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
  const credentials = (): CredentialUpdate | undefined =>
    keyId || secret || token || clearStsToken
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
      setError(
        "An access key ID and secret are required for a new storage configuration.",
      );
      return false;
    }
    if (clearStsToken && token.trim()) {
      setError("Clear the entered STS token before requesting its removal.");
      return false;
    }
    return true;
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !validate()) return;
    setBusy("save");
    setError("");
    try {
      await save(
        {
          ...input,
          name: input.name.trim(),
          region: input.region.trim(),
          bucket: input.bucket.trim(),
          endpoint: input.endpoint?.trim() ?? "",
          publicDomain: input.publicDomain?.trim() || null,
        },
        credentials(),
        selected?.id,
      );
      setStatus("Storage configuration saved.");
      setKeyId("");
      setSecret("");
      setToken("");
      setClearStsToken(false);
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    if (busy || !validate()) return;
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
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  };
  const changeEnabled = async (record: StorageSummary) => {
    if (busy) return;
    setBusy("save");
    setError("");
    try {
      await setEnabled(record.id, !record.enabled);
      await refresh();
      setStatus(record.enabled ? "Storage disabled." : "Storage enabled.");
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  };
  const visible = records.slice(page * 10, page * 10 + 10);
  return (
    <section
      className={`oss-kit ${className ?? ""}`.trim()}
      aria-labelledby={titleId}
      aria-busy={busy !== null}
    >
      <style>{styles}</style>
      <header className="oss-kit__header">
        <h2 className="oss-kit__title" id={titleId}>
          Storage configurations
        </h2>
        <p className="oss-kit__subtitle">
          Credentials are sent only to your host callback and are never listed
          here.
        </p>
      </header>
      <ul className="oss-kit__list" aria-label="Storage configurations">
        {visible.map((record) => (
          <li
            className="oss-kit__row"
            key={record.id}
            aria-current={selected?.id === record.id || undefined}
          >
            <span>
              <strong>{record.name}</strong>
              <br />
              <span className="oss-kit__row-meta">
                {record.region} · {record.bucket} · {record.access} ·{" "}
                {record.enabled ? "enabled" : "disabled"}
                {record.isDefault ? " · default" : ""}
              </span>
            </span>
            <span className="oss-kit__actions">
              <button
                className="oss-kit__button oss-kit__button--secondary"
                type="button"
                disabled={busy !== null}
                onClick={() => choose(record)}
              >
                Edit
              </button>
              <button
                className="oss-kit__button oss-kit__button--secondary"
                type="button"
                disabled={busy !== null || record.isDefault || !record.enabled}
                onClick={() =>
                  void (async () => {
                    setBusy("default");
                    try {
                      await setDefault(record.id);
                      await refresh();
                      setStatus("Default storage updated.");
                    } catch (caught) {
                      setError(messageFrom(caught));
                    } finally {
                      setBusy(null);
                    }
                  })()
                }
              >
                Make default
              </button>
              <button
                className="oss-kit__button oss-kit__button--secondary"
                type="button"
                disabled={busy !== null}
                onClick={() => void changeEnabled(record)}
              >
                {record.enabled ? "Disable" : "Enable"}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {records.length > 10 && (
        <nav className="oss-kit__pagination" aria-label="Storage pages">
          <button
            className="oss-kit__button oss-kit__button--secondary"
            type="button"
            disabled={busy !== null || page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {Math.ceil(records.length / 10)}
          </span>
          <button
            className="oss-kit__button oss-kit__button--secondary"
            type="button"
            disabled={busy !== null || (page + 1) * 10 >= records.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
      <div className="oss-kit__actions">
        <button
          className="oss-kit__button oss-kit__button--link"
          type="button"
          disabled={busy !== null}
          onClick={reset}
        >
          New storage configuration
        </button>
      </div>
      <form
        className="oss-kit__form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <fieldset
          disabled={busy !== null}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
          <div className="oss-kit__fields">
            <Field
              label="Name"
              value={input.name}
              onChange={(name) => setInput({ ...input, name })}
            />
            <Field
              label="Region"
              value={input.region}
              disabled={!!selected}
              onChange={(region) => setInput({ ...input, region })}
            />
            <Field
              label="Bucket"
              value={input.bucket}
              disabled={!!selected}
              onChange={(bucket) => setInput({ ...input, bucket })}
            />
            <Field
              label="Endpoint (optional)"
              value={input.endpoint ?? ""}
              onChange={(endpoint) => setInput({ ...input, endpoint })}
            />
            <label className="oss-kit__field">
              <span className="oss-kit__label">Access</span>
              <select
                className="oss-kit__select"
                value={input.access}
                disabled={!!selected?.used}
                onChange={(event) =>
                  setInput({
                    ...input,
                    access: event.target.value as "private" | "public",
                  })
                }
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </label>
            <Field
              label="Public domain (optional)"
              value={input.publicDomain ?? ""}
              onChange={(publicDomain) => setInput({ ...input, publicDomain })}
            />
          </div>
          <label className="oss-kit__check">
            <input
              type="checkbox"
              checked={input.enabled !== false}
              onChange={(event) =>
                setInput({ ...input, enabled: event.target.checked })
              }
            />
            Enabled
          </label>
          <div className="oss-kit__fields">
            <label className="oss-kit__field">
              <span className="oss-kit__label">Access key ID</span>
              <input
                className="oss-kit__input"
                type={showSecret ? "text" : "password"}
                autoComplete="off"
                aria-label="Access key ID"
                value={keyId}
                onChange={(event) => setKeyId(event.target.value)}
              />
              {selected && (
                <span className="oss-kit__hint">
                  Leave credential fields empty to keep saved credentials.
                </span>
              )}
            </label>
            {selected && (
              <label className="oss-kit__check">
                <input
                  type="checkbox"
                  checked={clearStsToken}
                  onChange={(event) => setClearStsToken(event.target.checked)}
                />
                Clear saved STS token
              </label>
            )}
            <label className="oss-kit__field">
              <span className="oss-kit__label">Access key secret</span>
              <span className="oss-kit__actions">
                <input
                  className="oss-kit__input"
                  type={showSecret ? "text" : "password"}
                  autoComplete="new-password"
                  aria-label="Access key secret"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
                <button
                  className="oss-kit__button oss-kit__button--link"
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  aria-label={
                    showSecret
                      ? "Hide access key secret"
                      : "Show access key secret"
                  }
                >
                  {showSecret ? "Hide" : "Show"}
                </button>
              </span>
            </label>
            <label className="oss-kit__field">
              <span className="oss-kit__label">STS token (optional)</span>
              <input
                className="oss-kit__input"
                type={showSecret ? "text" : "password"}
                autoComplete="off"
                aria-label="STS token (optional)"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <Field
              label="Admin test prefix"
              value={testPrefix}
              onChange={setTestPrefix}
              hint="Use an isolated prefix your administrator authorizes for test cleanup."
            />
          </div>
          <div className="oss-kit__actions">
            <button
              className="oss-kit__button oss-kit__button--primary"
              disabled={busy !== null}
            >
              {busy === "save" ? "Saving…" : "Save storage"}
            </button>
            <button
              className="oss-kit__button oss-kit__button--secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => void runTest()}
            >
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
          </div>
          <Messages error={error} status={status} />
          {result && <TestResult result={result} />}
        </fieldset>
      </form>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  hint,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  autoComplete?: string;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <label className="oss-kit__field" htmlFor={id}>
      <span className="oss-kit__label">{label}</span>
      <input
        className="oss-kit__input"
        id={id}
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hint ? hintId : undefined}
      />
      {hint && (
        <span className="oss-kit__hint" id={hintId}>
          {hint}
        </span>
      )}
    </label>
  );
}
function TestResult({ result }: { result: ConnectionTestResult }) {
  const entries = Object.entries({
    upload: result.upload,
    read: result.read,
    delete: result.delete,
  });
  return (
    <div aria-label="Connection test outcome">
      <p className="oss-kit__hint">Test object: {result.objectKey}</p>
      {entries.map(([name, step]) => (
        <p
          className={`oss-kit__result oss-kit__result--${step.status}`}
          key={name}
        >
          <strong>
            {name}: {step.status}
          </strong>
          {step.error && ` — ${step.error.message}`}
        </p>
      ))}
      {result.cleanupRequired && (
        <p className="oss-kit__message oss-kit__message--error" role="alert">
          Cleanup could not be confirmed. Remove the test object manually.
        </p>
      )}
    </div>
  );
}

export function StrategyEditor({
  listStorage,
  listStrategies,
  save,
  preview,
  className,
}: StrategyEditorProps) {
  const [storage, setStorage] = useState<StorageSummary[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selected, setSelected] = useState<Strategy | null>(null);
  const [input, setInput] = useState<StrategyDraft>(strategyDefaults);
  const [extensionsText, setExtensionsText] = useState("");
  const [mimeTypesText, setMimeTypesText] = useState("");
  const [maxSizeText, setMaxSizeText] = useState(String(10 * 1024 * 1024));
  const [originalName, setOriginalName] = useState("example.png");
  const [previewKey, setPreviewKey] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const titleId = useId();
  const refresh = async () => {
    try {
      const [nextStorage, nextStrategies] = await Promise.all([
        listStorage(),
        listStrategies(),
      ]);
      setStorage(nextStorage);
      setStrategies(nextStrategies);
    } catch (caught) {
      setError(messageFrom(caught));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    setPreviewKey("");
  }, [extensionsText, input, maxSizeText, mimeTypesText, originalName]);
  const choose = (strategy: Strategy) => {
    if (busy) return;
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
    if (busy) return;
    setSelected(null);
    setInput(strategyDefaults());
    setExtensionsText("");
    setMimeTypesText("");
    setMaxSizeText(String(10 * 1024 * 1024));
    setPreviewKey("");
    setError("");
    setStatus("");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
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
        allowedExtensions: lines(extensionsText).map((item: string) =>
          item.toLowerCase(),
        ),
        allowedMimeTypes: lines(mimeTypesText).map((item: string) =>
          item.toLowerCase(),
        ),
        maxSizeBytes,
      });
      setStatus("Strategy saved.");
      await refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  };
  const runPreview = async () => {
    if (busy || !originalName.trim()) return;
    const maxSizeBytes = asNumber(maxSizeText);
    if (!maxSizeBytes) {
      setError("Enter a positive maximum file size in bytes.");
      return;
    }
    setBusy("test");
    setError("");
    try {
      setPreviewKey(
        await preview(
          {
            ...input,
            allowedExtensions: lines(extensionsText),
            allowedMimeTypes: lines(mimeTypesText),
            maxSizeBytes,
          },
          originalName.trim(),
        ),
      );
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      className={`oss-kit ${className ?? ""}`.trim()}
      aria-labelledby={titleId}
      aria-busy={busy !== null}
    >
      <style>{styles}</style>
      <header className="oss-kit__header">
        <h2 className="oss-kit__title" id={titleId}>
          Upload strategies
        </h2>
        <p className="oss-kit__subtitle">
          Preview runs the host’s server-side naming rule.
        </p>
      </header>
      <ul className="oss-kit__list" aria-label="Upload strategies">
        {strategies.map((strategy) => (
          <li
            className="oss-kit__row"
            key={strategy.code}
            aria-current={selected?.code === strategy.code || undefined}
          >
            <span>
              <strong>{strategy.name}</strong>
              <br />
              <span className="oss-kit__row-meta">
                {strategy.code} · {strategy.enabled ? "enabled" : "disabled"}
              </span>
            </span>
            <button
              className="oss-kit__button oss-kit__button--secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => choose(strategy)}
            >
              Edit
            </button>
          </li>
        ))}
      </ul>
      <button
        className="oss-kit__button oss-kit__button--link"
        type="button"
        disabled={busy !== null}
        onClick={reset}
      >
        New strategy
      </button>
      <form
        className="oss-kit__form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <fieldset
          disabled={busy !== null}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
          <div className="oss-kit__fields">
            <Field
              label="Code"
              value={input.code}
              disabled={!!selected}
              onChange={(code) => setInput({ ...input, code })}
            />
            <Field
              label="Name"
              value={input.name}
              onChange={(name) => setInput({ ...input, name })}
            />
            <label className="oss-kit__field">
              <span className="oss-kit__label">Description</span>
              <textarea
                className="oss-kit__textarea resize-none"
                value={input.description}
                onChange={(event) =>
                  setInput({ ...input, description: event.target.value })
                }
              />
            </label>
            <label className="oss-kit__field">
              <span className="oss-kit__label">Storage binding</span>
              <select
                className="oss-kit__select"
                value={input.storageConfigId ?? ""}
                onChange={(event) =>
                  setInput({
                    ...input,
                    storageConfigId: event.target.value || null,
                  })
                }
              >
                <option value="">Default storage</option>
                {storage.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Object prefix"
              value={input.prefix}
              onChange={(prefix) => setInput({ ...input, prefix })}
            />
            <label className="oss-kit__field">
              <span className="oss-kit__label">Date directory</span>
              <select
                className="oss-kit__select"
                value={input.dateDirectory}
                onChange={(event) =>
                  setInput({
                    ...input,
                    dateDirectory: event.target
                      .value as StrategyDraft["dateDirectory"],
                  })
                }
              >
                <option value="fixed">Fixed</option>
                <option value="year-month">Year/month</option>
                <option value="year-month-day">Year/month/day</option>
              </select>
            </label>
            <label className="oss-kit__field">
              <span className="oss-kit__label">Naming</span>
              <select
                className="oss-kit__select"
                value={input.naming}
                onChange={(event) =>
                  setInput({
                    ...input,
                    naming: event.target.value as StrategyDraft["naming"],
                  })
                }
              >
                <option value="uuid">UUID</option>
                <option value="timestamp-random">Timestamp + random</option>
                <option value="original-random">Original + random</option>
              </select>
            </label>
            <Field
              label="Max size in bytes"
              value={maxSizeText}
              onChange={setMaxSizeText}
            />
          </div>
          <label className="oss-kit__field">
            <span className="oss-kit__label">Allowed extensions</span>
            <textarea
              className="oss-kit__textarea resize-none"
              value={extensionsText}
              onChange={(event) => setExtensionsText(event.target.value)}
              placeholder="png\njpg"
            />
          </label>
          <label className="oss-kit__field">
            <span className="oss-kit__label">Allowed MIME types</span>
            <textarea
              className="oss-kit__textarea resize-none"
              value={mimeTypesText}
              onChange={(event) => setMimeTypesText(event.target.value)}
              placeholder="image/png\nimage/jpeg"
            />
          </label>
          <label className="oss-kit__check">
            <input
              type="checkbox"
              checked={input.enabled !== false}
              onChange={(event) =>
                setInput({ ...input, enabled: event.target.checked })
              }
            />
            Enabled
          </label>
          <div className="oss-kit__actions">
            <button
              className="oss-kit__button oss-kit__button--primary"
              disabled={busy !== null}
            >
              {busy === "save" ? "Saving…" : "Save strategy"}
            </button>
          </div>
          <div className="oss-kit__fields">
            <Field
              label="Original file name for preview"
              value={originalName}
              onChange={setOriginalName}
            />
            <div className="oss-kit__field">
              <span className="oss-kit__label">Server preview</span>
              <output className="oss-kit__input">
                {previewKey || "No preview yet"}
              </output>
            </div>
          </div>
          <button
            className="oss-kit__button oss-kit__button--secondary"
            type="button"
            disabled={busy !== null}
            onClick={() => void runPreview()}
          >
            {busy === "test" ? "Previewing…" : "Preview object key"}
          </button>
          <Messages error={error} status={status} />
        </fieldset>
      </form>
    </section>
  );
}

export function UploadExample({
  listStrategies,
  upload,
  getLink,
  className,
}: UploadExampleProps) {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [code, setCode] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [reference, setReference] = useState<FileReference | null>(null);
  const [link, setLink] = useState<AccessLink | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const titleId = useId();
  useEffect(() => {
    void (async () => {
      try {
        const next = await listStrategies();
        setStrategies(next.filter((strategy) => strategy.enabled));
      } catch (caught) {
        setError(messageFrom(caught));
      }
    })();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
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
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  };
  const requestLink = async () => {
    if (!reference || busy) return;
    setBusy("link");
    setError("");
    try {
      const next = await getLink(reference);
      setLink(next);
      setStatus("Access link created.");
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      className={`oss-kit ${className ?? ""}`.trim()}
      aria-labelledby={titleId}
      aria-busy={busy !== null}
    >
      <style>{styles}</style>
      <header className="oss-kit__header">
        <h2 className="oss-kit__title" id={titleId}>
          Upload a file
        </h2>
        <p className="oss-kit__subtitle">
          This reference calls your trusted host; it never claims an upload
          succeeded before the host responds.
        </p>
      </header>
      <form
        className="oss-kit__form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <label className="oss-kit__field">
          <span className="oss-kit__label">Strategy</span>
          <select
            className="oss-kit__select"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          >
            <option value="">Choose a strategy</option>
            {strategies.map((strategy) => (
              <option value={strategy.code} key={strategy.code}>
                {strategy.name}
              </option>
            ))}
          </select>
        </label>
        <label className="oss-kit__field">
          <span className="oss-kit__label">File</span>
          <input
            className="oss-kit__input"
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          {file && (
            <span className="oss-kit__hint">
              {file.name} · {file.size.toLocaleString()} bytes
            </span>
          )}
        </label>
        <button
          className="oss-kit__button oss-kit__button--primary"
          disabled={busy !== null}
        >
          {busy === "upload" ? "Uploading…" : "Upload file"}
        </button>
        <Messages error={error} status={status} />
        {reference && (
          <div className="oss-kit__result">
            <p>
              <strong>Uploaded:</strong> {reference.originalName}
            </p>
            <button
              className="oss-kit__button oss-kit__button--secondary"
              type="button"
              disabled={busy !== null}
              onClick={() => void requestLink()}
            >
              {busy === "link" ? "Creating link…" : "Get access link"}
            </button>
          </div>
        )}
        {link && (
          <div className="oss-kit__result oss-kit__result--passed">
            <a href={link.url}>Open transient access link</a>
            <p className="oss-kit__hint">
              {link.access} access
              {link.expiresAt
                ? ` · expires ${link.expiresAt}`
                : " · no expiry returned"}
            </p>
          </div>
        )}
      </form>
    </section>
  );
}
