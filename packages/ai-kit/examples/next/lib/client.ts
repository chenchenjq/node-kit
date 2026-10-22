"use client";
import type {
  CallInput,
  ConnectionInput,
  ConnectionSummary,
  DictionaryItem,
  Plan,
  PlanInput,
  PlanSummary,
  StreamEvent,
  TestDraft,
  TestResult,
} from "ai-kit";
const base = "/api/ai-kit";
async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(
    `${base}/${path}`,
    input === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          cache: "no-store",
        },
  );
  const value = (await response.json()) as { data: T; error?: unknown };
  if (!response.ok) throw value.error;
  return value.data;
}
export const managerCallbacks = {
  async load() {
    const [providers, connections, plans] = await Promise.all([
      request<DictionaryItem[]>("admin/providers"),
      request<ConnectionSummary[]>("admin/connections"),
      request<Plan[]>("admin/plans"),
    ]);
    return { providers, connections, plans };
  },
  saveConnection: (input: ConnectionInput) =>
    request("admin/connections", input),
  savePlan: (input: PlanInput) => request("admin/plans", input),
  testDraft: (input: TestDraft) =>
    request<TestResult>("admin/test-draft", input),
  testPlan: (code: string) => request<TestResult>("admin/test-plan", { code }),
  setDefault: async (code: string | null) => {
    await request("admin/default", { code });
  },
  refreshModels: (connectionId: string) =>
    request<string[]>("admin/models", { connectionId }),
};
export const businessCallbacks = {
  listPlans: () => request<PlanSummary[]>("plans"),
  stream,
};
async function* stream(input: CallInput): AsyncGenerator<StreamEvent> {
  const { signal, ...payload } = input;
  const response = await fetch(`${base}/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const data = (await response.json()) as { error: unknown };
    throw data.error;
  }
  if (!response.body) throw { code: "STREAM_INTERRUPTED" };
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    terminal = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      pending += decoder.decode(part.value, { stream: true });
      if (pending.length > 300000) throw { code: "OUTPUT_LIMIT" };
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        const row = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!row) continue;
        const event = JSON.parse(row) as StreamEvent;
        if (event.type === "finish" || event.type === "error") terminal = true;
        yield event;
      }
    }
    if (!terminal)
      yield {
        type: "error",
        error: {
          code: "STREAM_INTERRUPTED",
          message: "流中断，未取得最终状态",
        },
      };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
