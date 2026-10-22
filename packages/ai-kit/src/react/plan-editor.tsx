"use client";
import { useRef, useState } from "react";
import type {
  ConnectionSummary,
  GenerationParameters,
  Plan,
  PlanInput,
  TestResult,
} from "../types.js";
import { modelPresets } from "../catalog.js";
import { Feedback, Field, TestFeedback, useOperation } from "./shared.js";
export interface PlanEditorProps {
  connections: ConnectionSummary[];
  plan?: Plan | undefined;
  save(input: PlanInput): Promise<void>;
  test?(input: PlanInput): Promise<TestResult>;
  className?: string | undefined;
}
export function PlanEditor({
  connections,
  plan,
  save,
  test,
  className,
}: PlanEditorProps) {
  const first = connections[0],
    initialModel =
      modelPresets.find((p) => p.providerCode === first?.providerCode)
        ?.modelId ?? "";
  const [draft, setDraft] = useState<PlanInput>(
      plan ?? {
        code: "",
        name: "",
        connectionId: first?.id ?? "",
        modelId: initialModel,
        enabled: true,
        isDefault: false,
        systemPrompt: null,
        parameters: {},
      },
    ),
    op = useOperation();
  const [fee, setFee] = useState(false),
    [tested, setTested] = useState<TestResult | null>(null);
  const connection = connections.find((c) => c.id === draft.connectionId),
    presets = modelPresets.filter(
      (p) => p.providerCode === connection?.providerCode,
    ),
    preset = presets.find((p) => p.modelId === draft.modelId);
  const draftVersion = useRef(0),
    feedbackVersion = useRef(0);
  const params = draft.parameters ?? {};
  const patch = (changes: Partial<PlanInput>) => {
    draftVersion.current++;
    setTested(null);
    setDraft((d) => ({ ...d, ...changes }));
  };
  function parameter(name: keyof GenerationParameters, value: string) {
    const updated = { ...params };
    if (value === "") delete updated[name];
    else if (name === "thinking")
      updated.thinking = value as "enabled" | "disabled";
    else updated[name] = Number(value);
    patch({ parameters: updated });
  }
  return (
    <form
      className={className ?? "ai-kit-form"}
      noValidate
      aria-busy={!!op.busy}
      onSubmit={(e) => {
        e.preventDefault();
        void op.run("保存方案", () => {
          feedbackVersion.current = draftVersion.current;
          return save(draft);
        });
      }}
    >
      <h3>{plan ? "编辑方案" : "新增方案"}</h3>
      <Field label="方案 code" hint="创建后不可修改，业务通过此 code 调用。">
        {(id) => (
          <input
            id={id}
            value={draft.code}
            readOnly={!!plan}
            required
            onChange={(e) => patch({ code: e.target.value })}
          />
        )}
      </Field>
      <Field label="方案名称">
        {(id) => (
          <input
            id={id}
            value={draft.name}
            required
            onChange={(e) => patch({ name: e.target.value })}
          />
        )}
      </Field>
      <Field label="连接">
        {(id) => (
          <select
            id={id}
            value={draft.connectionId}
            onChange={(e) => {
              const c = connections.find((c) => c.id === e.target.value);
              patch({
                connectionId: e.target.value,
                modelId:
                  modelPresets.find((p) => p.providerCode === c?.providerCode)
                    ?.modelId ?? "",
              });
            }}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.providerCode}
                {c.enabled ? "" : "（停用）"}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="模型预设">
        {(id) => (
          <select
            id={id}
            value={preset?.modelId ?? ""}
            onChange={(e) => {
              if (e.target.value) patch({ modelId: e.target.value });
            }}
          >
            <option value="">手工输入</option>
            {presets.map((p) => (
              <option key={p.modelId} value={p.modelId}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="模型 ID"
        hint="可手工输入；保留大小写。预设外模型需宿主核实参数能力。"
      >
        {(id) => (
          <input
            id={id}
            value={draft.modelId}
            required
            onChange={(e) => patch({ modelId: e.target.value })}
          />
        )}
      </Field>
      <Field label="默认 systemPrompt" hint="只允许管理员配置可信系统指令。">
        {(id) => (
          <textarea
            className="resize-none"
            id={id}
            style={{ resize: "none" }}
            rows={3}
            value={draft.systemPrompt ?? ""}
            onChange={(e) => patch({ systemPrompt: e.target.value || null })}
          />
        )}
      </Field>
      {(
        [
          "temperature",
          "topP",
          "maxOutputTokens",
          "timeoutMs",
          "maxRetries",
        ] as const
      ).map((name) => (
        <Field
          key={name}
          label={name}
          hint={
            name === "temperature" || name === "topP"
              ? "留空不发送；仅核实支持的模型开放。"
              : name === "maxOutputTokens"
                ? "缺省有限预算，含推理 tokens；不会保证同量最终正文。"
                : name === "timeoutMs"
                  ? "默认 60000"
                  : "默认 0；仅明确拒绝的限流可重试。"
          }
        >
          {(id) => (
            <input
              id={id}
              type="number"
              step={name === "temperature" || name === "topP" ? "any" : "1"}
              disabled={
                params[name] === undefined &&
                ((name === "temperature" && !preset?.temperature) ||
                  (name === "topP" && !preset?.topP))
              }
              value={params[name] ?? ""}
              onChange={(e) => parameter(name, e.target.value)}
            />
          )}
        </Field>
      ))}
      {(preset?.thinking || params.thinking !== undefined) && (
        <Field label="思考选项">
          {(id) => (
            <select
              id={id}
              value={params.thinking ?? ""}
              onChange={(e) => parameter("thinking", e.target.value)}
            >
              <option value="">使用厂商默认</option>
              <option value="enabled">启用思考</option>
              <option value="disabled">关闭思考</option>
            </select>
          )}
        </Field>
      )}
      <label>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        启用方案
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.isDefault}
          disabled={
            !draft.isDefault && (!draft.enabled || !connection?.enabled)
          }
          onChange={(e) => patch({ isDefault: e.target.checked })}
        />
        设为默认方案（替换当前默认）
      </label>
      {!connections.length && <p role="status">先新增连接，再创建调用方案。</p>}
      <button type="submit" disabled={!!op.busy || !connections.length}>
        {op.busy ? "保存方案中…" : "保存方案"}
      </button>
      <p>停用默认方案前，请明确取消默认标记或重新指定默认。</p>
      {test && (
        <fieldset>
          <legend>测试当前方案表单</legend>
          <label>
            <input
              type="checkbox"
              checked={fee}
              onChange={(e) => setFee(e.target.checked)}
            />
            确认当前方案测试可能产生费用
          </label>
          <button
            type="button"
            disabled={!fee || !!op.busy}
            onClick={() =>
              void op.run("测试当前方案", async () => {
                const version = draftVersion.current;
                feedbackVersion.current = version;
                const result = await test(draft);
                if (draftVersion.current === version) setTested(result);
              })
            }
          >
            测试当前方案
          </button>
          <TestFeedback value={tested} />
        </fieldset>
      )}
      <Feedback
        message={
          feedbackVersion.current === draftVersion.current ? op.message : ""
        }
        failed={op.failed}
      />
    </form>
  );
}
