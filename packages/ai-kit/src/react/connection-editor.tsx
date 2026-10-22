"use client";
import { useRef, useState } from "react";
import type {
  ConnectionInput,
  ConnectionSummary,
  DictionaryItem,
  Protocol,
  TestDraft,
  TestResult,
} from "../types.js";
import { modelPresets, providerAdapters } from "../catalog.js";
import { Feedback, Field, TestFeedback, useOperation } from "./shared.js";
export interface ConnectionEditorProps {
  providers: DictionaryItem[];
  connection?: ConnectionSummary | undefined;
  save(input: ConnectionInput): Promise<void>;
  test(input: TestDraft): Promise<TestResult>;
  className?: string | undefined;
}
export function ConnectionEditor({
  providers,
  connection,
  save,
  test,
  className,
}: ConnectionEditorProps) {
  const first = providers.find((p) => p.enabled)?.code ?? "",
    initial = providerAdapters.find((a) => a.code === first);
  const [draft, setDraft] = useState<ConnectionInput>(() =>
    connection
      ? { ...connection, apiKey: "" }
      : {
          name: "",
          providerCode: first,
          protocol: initial?.recommendedProtocol ?? "openai-chat",
          baseURL: initial?.endpoints[0]?.baseURL ?? "",
          apiKey: "",
          enabled: true,
        },
  );
  // Copy only write DTO fields; protected fields never enter this component.
  function input(): ConnectionInput {
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
  const [modelId, setModelId] = useState(
      modelPresets.find((p) => p.providerCode === draft.providerCode)
        ?.modelId ?? "",
    ),
    [fee, setFee] = useState(false),
    [showKey, setShowKey] = useState(false),
    [tested, setTested] = useState<TestResult | null>(null),
    op = useOperation();
  const draftVersion = useRef(0),
    feedbackVersion = useRef(0);
  const adapter = providerAdapters.find((a) => a.code === draft.providerCode);
  function provider(code: string) {
    const a = providerAdapters.find((a) => a.code === code);
    setDraft((d) => ({
      ...d,
      providerCode: code,
      protocol: a?.recommendedProtocol ?? "openai-chat",
      baseURL: a?.endpoints[0]?.baseURL ?? "",
    }));
    setModelId(
      modelPresets.find((p) => p.providerCode === code)?.modelId ?? "",
    );
    draftVersion.current++;
    setTested(null);
  }
  const patch = (changes: Partial<ConnectionInput>) => {
    setDraft((d) => ({ ...d, ...changes }));
    draftVersion.current++;
    setTested(null);
  };
  return (
    <form
      className={className ?? "ai-kit-form"}
      noValidate
      aria-busy={!!op.busy}
      onSubmit={(e) => {
        e.preventDefault();
        void op.run("保存连接", async () => {
          feedbackVersion.current = draftVersion.current;
          setTested(null);
          const submitted = input();
          await save(submitted);
          setDraft((d) =>
            d.apiKey === submitted.apiKey ? { ...d, apiKey: "" } : d,
          );
        });
      }}
    >
      <h3>{connection ? "编辑连接" : "新增连接"}</h3>
      <Field label="连接名称">
        {(id) => (
          <input
            id={id}
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            required
            maxLength={100}
          />
        )}
      </Field>
      <Field label="厂商">
        {(id) => (
          <select
            id={id}
            value={draft.providerCode}
            onChange={(e) => provider(e.target.value)}
          >
            {providers
              .filter((p) => p.enabled || p.code === draft.providerCode)
              .map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
          </select>
        )}
      </Field>
      {!adapter && <p role="alert">该字典厂商尚无适配，不能保存或调用。</p>}
      <Field label="协议">
        {(id) => (
          <select
            id={id}
            value={draft.protocol}
            onChange={(e) => patch({ protocol: e.target.value as Protocol })}
          >
            {(adapter?.protocols ?? []).map((p) => (
              <option key={p} value={p}>
                {p === "openai-chat"
                  ? "OpenAI Chat Completions"
                  : p === "openai-responses"
                    ? "OpenAI Responses"
                    : "Anthropic Messages"}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="地址模板"
        hint="地域和业务空间的密钥不通用；套餐端点请按官方文档核对用途。"
      >
        {(id) => (
          <select
            id={id}
            value=""
            onChange={(e) => {
              const t = adapter?.endpoints.find(
                (t) => t.baseURL === e.target.value,
              );
              if (t) patch({ baseURL: t.baseURL, protocol: t.protocol });
            }}
          >
            <option value="">选择普通 API 模板</option>
            {adapter?.endpoints.map((t) => (
              <option key={t.baseURL} value={t.baseURL}>
                {t.name} · {t.baseURL}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="BaseURL"
        hint="填写 SDK 基础路径，不附加 chat/completions、responses 或 messages。"
      >
        {(id) => (
          <input
            id={id}
            type="url"
            value={draft.baseURL}
            onChange={(e) => patch({ baseURL: e.target.value })}
            required
          />
        )}
      </Field>
      <Field
        label="API Key"
        hint={
          connection
            ? "已保存密钥不会回显，留空保留。"
            : "由可信后端保护；也可使用宿主允许的 env:变量名。"
        }
      >
        {(id) => (
          <input
            id={id}
            type={showKey ? "text" : "password"}
            autoComplete="off"
            value={draft.apiKey ?? ""}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
        )}
      </Field>
      <button
        type="button"
        aria-pressed={showKey}
        onClick={() => setShowKey((s) => !s)}
      >
        {showKey ? "隐藏密钥" : "显示新输入密钥"}
      </button>
      <label>
        <input
          type="checkbox"
          checked={!!draft.confirmKeyDomainChange}
          onChange={(e) => patch({ confirmKeyDomainChange: e.target.checked })}
        />
        地址或厂商变化后，我已确认密钥可用于新目标
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        启用连接
      </label>
      <label>
        <input
          type="checkbox"
          checked={!!draft.clearDefault}
          onChange={(e) => patch({ clearDefault: e.target.checked })}
        />
        停用连接时清空关联默认方案
      </label>
      <button disabled={!!op.busy || !adapter} type="submit">
        {op.busy === "保存连接" ? "保存连接中…" : "保存连接"}
      </button>
      <fieldset>
        <legend>测试当前表单</legend>
        <Field label="测试模型 ID">
          {(id) => (
            <input
              id={id}
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value);
                draftVersion.current++;
                setTested(null);
              }}
            />
          )}
        </Field>
        <label>
          <input
            type="checkbox"
            checked={fee}
            onChange={(e) => setFee(e.target.checked)}
          />
          我知道测试会调用模型并可能产生费用
        </label>
        <p>
          使用无业务数据的短消息，输出预算最多 128
          tokens；思考模型可能未产生最终正文。
        </p>
        <button
          type="button"
          disabled={!fee || !!op.busy || !adapter}
          onClick={() =>
            void op.run("测试", async () => {
              const version = draftVersion.current;
              feedbackVersion.current = version;
              const result = await test({ connection: input(), modelId });
              if (draftVersion.current === version) setTested(result);
            })
          }
        >
          测试当前表单
        </button>
        <TestFeedback value={tested} />
      </fieldset>
      <Feedback
        message={
          feedbackVersion.current === draftVersion.current ? op.message : ""
        }
        failed={op.failed}
      />
    </form>
  );
}
