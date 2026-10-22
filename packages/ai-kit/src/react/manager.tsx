"use client";
import { useEffect, useState } from "react";
import type {
  ConnectionInput,
  ConnectionSummary,
  DictionaryItem,
  Plan,
  PlanInput,
  TestDraft,
  TestResult,
} from "../types.js";
import { ConnectionEditor } from "./connection-editor.js";
import { PlanEditor } from "./plan-editor.js";
import {
  Feedback,
  Field,
  TestFeedback,
  safeMessage,
  useOperation,
} from "./shared.js";
export interface AiManagerProps {
  load(): Promise<{
    providers: DictionaryItem[];
    connections: ConnectionSummary[];
    plans: Plan[];
  }>;
  saveConnection(input: ConnectionInput): Promise<unknown>;
  savePlan(input: PlanInput): Promise<unknown>;
  testDraft(input: TestDraft): Promise<TestResult>;
  testPlan(code: string): Promise<TestResult>;
  setDefault(code: string | null): Promise<void>;
  refreshModels?(connectionId: string): Promise<string[]>;
  className?: string | undefined;
}
export function AiManager(props: AiManagerProps) {
  const [data, setData] = useState<{
      providers: DictionaryItem[];
      connections: ConnectionSummary[];
      plans: Plan[];
    } | null>(null),
    [connectionId, setConnectionId] = useState(""),
    [planCode, setPlanCode] = useState(""),
    [version, setVersion] = useState(0),
    [fee, setFee] = useState(false),
    [tested, setTested] = useState<TestResult | null>(null),
    [models, setModels] = useState<string[]>([]),
    op = useOperation();
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    void props
      .load()
      .then(
        (next) => {
          if (active) {
            setData(next);
            setVersion((v) => v + 1);
          }
        },
        (error) => {
          if (active) setLoadError(safeMessage(error));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
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
    return (
      <section aria-label="AI 管理">
        <p role="status">
          {loading || op.busy ? "正在读取配置…" : "配置尚未读取"}
        </p>
        <Feedback
          message={loadError || op.message}
          failed={!!loadError || op.failed}
        />
        <button onClick={() => void op.run("读取配置", reload)}>
          重新加载
        </button>
      </section>
    );
  const c = data.connections.find((c) => c.id === connectionId),
    p = data.plans.find((p) => p.code === planCode);
  return (
    <section
      className={props.className ?? "ai-kit-manager"}
      aria-label="AI 管理"
    >
      <header>
        <h2>AI 连接与调用方案</h2>
        <p>默认方案：{data.plans.find((p) => p.isDefault)?.code ?? "未设置"}</p>
        <button
          disabled={!!op.busy}
          onClick={() => void op.run("重新加载", reload)}
        >
          重新加载配置
        </button>
        <button
          disabled={!!op.busy}
          onClick={() =>
            void op.run("清空默认", async () => {
              await props.setDefault(null);
              await reload();
            })
          }
        >
          清空默认方案
        </button>
      </header>
      <div className="ai-kit-columns">
        <section aria-label="连接管理">
          <Field label="选择连接">
            {(id) => (
              <select
                id={id}
                value={connectionId}
                onChange={(e) => {
                  setConnectionId(e.target.value);
                  setModels([]);
                }}
              >
                <option value="">新增连接</option>
                {data.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.enabled ? "启用" : "停用"} ·{" "}
                    {c.testedRevision === c.revision ? "已测试" : "待测试"}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <ConnectionEditor
            key={`${connectionId}:${version}`}
            connection={c}
            providers={data.providers}
            save={async (input) => {
              await props.saveConnection(input);
              await reload();
            }}
            test={props.testDraft}
          />
          {props.refreshModels && c && (
            <>
              <button
                disabled={!!op.busy}
                onClick={() =>
                  void op.run("刷新模型", async () =>
                    setModels(await props.refreshModels!(c.id)),
                  )
                }
              >
                手动刷新模型列表
              </button>
              {models.length > 0 && <p>可用模型：{models.join("、")}</p>}
            </>
          )}
        </section>
        <section aria-label="方案管理">
          <Field label="选择方案">
            {(id) => (
              <select
                id={id}
                value={planCode}
                onChange={(e) => {
                  setPlanCode(e.target.value);
                  setTested(null);
                }}
              >
                <option value="">新增方案</option>
                {data.plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name} · {p.code}
                    {p.isDefault ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <PlanEditor
            key={`${planCode}:${version}`}
            plan={p}
            connections={data.connections}
            save={async (input) => {
              await props.savePlan(input);
              await reload();
            }}
            test={async (input) => {
              const conn = data.connections.find(
                (c) => c.id === input.connectionId,
              );
              if (!conn) throw { code: "NOT_FOUND" };
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
            }}
          />
          {p && (
            <fieldset>
              <legend>测试已保存方案</legend>
              <label>
                <input
                  type="checkbox"
                  checked={fee}
                  onChange={(e) => setFee(e.target.checked)}
                />
                确认可能产生费用
              </label>
              <button
                disabled={!fee || !!op.busy}
                onClick={() =>
                  void op.run("测试已保存方案", async () =>
                    setTested(await props.testPlan(p.code)),
                  )
                }
              >
                测试已保存方案
              </button>
              <TestFeedback value={tested} />
            </fieldset>
          )}
        </section>
      </div>
      <Feedback message={op.message} failed={op.failed} />
    </section>
  );
}
