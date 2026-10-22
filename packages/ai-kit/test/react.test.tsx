// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { ConnectionEditor, PlanEditor } from "../src/react/index.js";
import { providerSeeds } from "../src/catalog.js";
import type {
  ConnectionSummary,
  ConnectionInput,
  PlanInput,
} from "../src/types.js";
afterEach(cleanup);
const connection: ConnectionSummary = {
  id: "c",
  name: "qwen",
  providerCode: "qwen",
  protocol: "openai-chat",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  enabled: true,
  revision: 1,
  hasCredential: true,
  testedRevision: null,
};
it("keeps saved key blank and submits a new key through the trusted callback only", async () => {
  const save = vi.fn(async (_input: ConnectionInput) => {});
  render(
    <ConnectionEditor
      providers={[...providerSeeds]}
      connection={connection}
      save={save}
      test={async () => ({
        status: "completed",
        result: null,
        error: null,
        durationMs: 1,
      })}
    />,
  );
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "new-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    apiKey: "new-secret",
    id: "c",
    revision: 1,
  });
  await waitFor(() =>
    expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
      "",
    ),
  );
});
it("offers model presets plus exact hand-filled ID and uses the selected connection provider", async () => {
  const save = vi.fn(async (_input: PlanInput) => {});
  render(<PlanEditor connections={[connection]} save={save} />);
  fireEvent.change(screen.getByLabelText("方案 code"), {
    target: { value: "custom" },
  });
  fireEvent.change(screen.getByLabelText("方案名称"), {
    target: { value: "自定义" },
  });
  fireEvent.change(screen.getByLabelText("模型 ID"), {
    target: { value: "My-Exact-ID" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    code: "custom",
    modelId: "My-Exact-ID",
  });
});
it("requires a fee acknowledgement before draft test and shows incomplete distinctly", async () => {
  const test = vi.fn(async () => ({
    status: "incomplete" as const,
    result: null,
    error: null,
    durationMs: 1,
  }));
  render(
    <ConnectionEditor
      providers={[...providerSeeds]}
      connection={connection}
      save={async () => {}}
      test={test}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "测试当前表单" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("我知道测试会调用模型并可能产生费用"));
  fireEvent.click(screen.getByRole("button", { name: "测试当前表单" }));
  await waitFor(() => expect(screen.getByText(/未完成/)).toBeTruthy());
});
it("keeps a safe inline error after rejected save, without losing non-sensitive fields", async () => {
  render(
    <ConnectionEditor
      providers={[...providerSeeds]}
      connection={connection}
      save={async () => {
        throw { code: "CONFLICT", message: "raw secret" };
      }}
      test={async () => ({
        status: "failed",
        result: null,
        error: null,
        durationMs: 1,
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("重新加载"),
  );
  expect((screen.getByLabelText("连接名称") as HTMLInputElement).value).toBe(
    "qwen",
  );
  expect(document.body.textContent).not.toContain("raw secret");
});
it("loads manager under React StrictMode without losing the completed request", async () => {
  const { StrictMode } = await import("react");
  const { AiManager } = await import("../src/react/index.js");
  render(
    <StrictMode>
      <AiManager
        load={async () => ({
          providers: [...providerSeeds],
          connections: [connection],
          plans: [],
        })}
        saveConnection={async () => {}}
        savePlan={async () => {}}
        testDraft={async () => ({
          status: "completed",
          result: null,
          error: null,
          durationMs: 1,
        })}
        testPlan={async () => ({
          status: "completed",
          result: null,
          error: null,
          durationMs: 1,
        })}
        setDefault={async () => {}}
      />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "AI 连接与调用方案" }),
    ).toBeTruthy(),
  );
});
it("lets an administrator explicitly clear default after disabling a plan", async () => {
  const save = vi.fn(async (_input: PlanInput) => {});
  render(
    <PlanEditor
      connections={[connection]}
      plan={{
        id: "p",
        revision: 1,
        code: "p",
        name: "p",
        connectionId: "c",
        modelId: "qwen-plus",
        enabled: true,
        isDefault: true,
        systemPrompt: null,
        parameters: {},
      }}
      save={save}
    />,
  );
  fireEvent.click(screen.getByLabelText("启用方案"));
  const defaultBox = screen.getByLabelText(
    "设为默认方案（替换当前默认）",
  ) as HTMLInputElement;
  expect(defaultBox.checked).toBe(true);
  expect(defaultBox.disabled).toBe(false);
  fireEvent.click(defaultBox);
  fireEvent.click(screen.getByRole("button", { name: "保存方案" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    enabled: false,
    isDefault: false,
  });
});
it("saves the same newly entered key that the draft test verified", async () => {
  const test = vi.fn(async () => ({
      status: "completed" as const,
      result: null,
      error: null,
      durationMs: 1,
    })),
    save = vi.fn(async (_input: ConnectionInput) => {});
  render(
    <ConnectionEditor
      providers={[...providerSeeds]}
      connection={connection}
      save={save}
      test={test}
    />,
  );
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "rotation-key" },
  });
  fireEvent.click(screen.getByLabelText("我知道测试会调用模型并可能产生费用"));
  fireEvent.click(screen.getByRole("button", { name: "测试当前表单" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("测试完成"),
  );
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
    "rotation-key",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0]).toMatchObject({ apiKey: "rotation-key" });
});
it.each([false, true])(
  "invalidates plan test feedback when configuration changes (pending=%s)",
  async (pending) => {
    let resolve!: (value: import("../src/types.js").TestResult) => void;
    const result: import("../src/types.js").TestResult = {
      status: "completed",
      result: {
        text: "OLD-CONFIG-REPLY",
        reasoning: "",
        code: "p",
        providerCode: "qwen",
        modelId: "qwen-plus",
        status: "completed",
        finishReason: "stop",
        durationMs: 1,
        requestId: null,
        usage: null,
      },
      error: null,
      durationMs: 1,
    };
    const test = vi.fn(async () =>
      pending
        ? new Promise<import("../src/types.js").TestResult>(
            (r) => (resolve = r),
          )
        : result,
    );
    render(
      <PlanEditor
        connections={[connection]}
        save={async () => {}}
        test={test}
      />,
    );
    fireEvent.click(screen.getByLabelText("确认当前方案测试可能产生费用"));
    fireEvent.click(screen.getByRole("button", { name: "测试当前方案" }));
    await waitFor(() => expect(test).toHaveBeenCalled());
    if (!pending)
      await waitFor(() =>
        expect(screen.getByText("OLD-CONFIG-REPLY")).toBeTruthy(),
      );
    fireEvent.change(screen.getByLabelText("模型 ID"), {
      target: { value: "New-Model-ID" },
    });
    if (pending) resolve(result);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "测试当前方案",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText("OLD-CONFIG-REPLY")).toBeNull();
    expect(screen.queryByText("测试当前方案完成")).toBeNull();
  },
);
it.each([false, true])(
  "invalidates connection test feedback after key edits (pending=%s)",
  async (pending) => {
    let resolve!: (value: import("../src/types.js").TestResult) => void;
    const result: import("../src/types.js").TestResult = {
      status: "completed",
      result: {
        text: "OLD-KEY-REPLY",
        reasoning: "",
        code: "p",
        providerCode: "qwen",
        modelId: "qwen-plus",
        status: "completed",
        finishReason: "stop",
        durationMs: 1,
        requestId: null,
        usage: null,
      },
      error: null,
      durationMs: 1,
    };
    const test = vi.fn(async () =>
      pending
        ? new Promise<import("../src/types.js").TestResult>(
            (r) => (resolve = r),
          )
        : result,
    );
    render(
      <ConnectionEditor
        providers={[...providerSeeds]}
        connection={connection}
        save={async () => {}}
        test={test}
      />,
    );
    fireEvent.click(
      screen.getByLabelText("我知道测试会调用模型并可能产生费用"),
    );
    fireEvent.click(screen.getByRole("button", { name: "测试当前表单" }));
    await waitFor(() => expect(test).toHaveBeenCalled());
    if (!pending)
      await waitFor(() =>
        expect(screen.getByText("OLD-KEY-REPLY")).toBeTruthy(),
      );
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "edited-key" },
    });
    if (pending) resolve(result);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "测试当前表单",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText("OLD-KEY-REPLY")).toBeNull();
    expect(screen.queryByText("测试完成")).toBeNull();
  },
);
it("retains an unsaved rotation key after rejected save and retries with the same key", async () => {
  let calls = 0;
  const save = vi.fn(async (_input: ConnectionInput) => {
    if (++calls === 1) throw { code: "NETWORK" };
  });
  render(
    <ConnectionEditor
      providers={[...providerSeeds]}
      connection={connection}
      save={save}
      test={async () => ({
        status: "completed",
        result: null,
        error: null,
        durationMs: 1,
      })}
    />,
  );
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "retry-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
    "retry-key",
  );
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]?.[0]).toMatchObject({ apiKey: "retry-key" });
  await waitFor(() =>
    expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
      "",
    ),
  );
});

it("preserves a newer key entered while an earlier save is pending", async () => {
  let resolve!: () => void;
  const save = vi.fn(
    async (_input: ConnectionInput) =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  render(
    <ConnectionEditor
      providers={[...providerSeeds]}
      connection={connection}
      save={save}
      test={async () => ({
        status: "completed",
        result: null,
        error: null,
        durationMs: 1,
      })}
    />,
  );
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "submitted-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存连接" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "newer-key" },
  });
  resolve();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "保存连接" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(save.mock.calls[0]?.[0]).toMatchObject({ apiKey: "submitted-key" });
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(
    "newer-key",
  );
});
