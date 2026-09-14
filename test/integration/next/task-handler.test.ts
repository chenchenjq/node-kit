import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createSmsTaskHandler } from "../../../src/next/index.js";

const taskNames = ["send-worker", "dispatch-recovery", "receipt-reconcile", "data-retention", "daily-rollup", "resource-sync"] as const;

function tasks() {
  const configured = {} as Record<typeof taskNames[number], {
    runBatch: ReturnType<typeof vi.fn<(input: Readonly<{ limit: number }>) => Promise<number>>>;
  }>;
  for (const name of taskNames) {
    configured[name] = { runBatch: vi.fn<(input: Readonly<{ limit: number }>) => Promise<number>>(async () => 2) };
  }
  return configured;
}

function handler(options: Readonly<{ verified?: boolean; batchLimit?: number }>) {
  const configuredTasks = tasks();
  return {
    tasks: configuredTasks,
    callback: createSmsTaskHandler({
      verifyScheduler: async (request) => request.headers.get("x-scheduler") === "verified" && (options.verified ?? true),
      tasks: configuredTasks,
      batchLimit: options.batchLimit ?? 25,
      ids: { next: () => "request-123" },
    }),
  };
}

function request(task: string, scheduler = "verified", method = "POST", body?: string): Request {
  return new Request(`https://sms.example.test/api/tasks?task=${encodeURIComponent(task)}`, {
    method,
    headers: { "x-scheduler": scheduler, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  });
}

describe("scheduled task Route Handler", () => {
  it("verifies the scheduler before parsing or running an untrusted task request", async () => {
    const taskHandler = handler({ verified: false });
    const body = new ReadableStream<Uint8Array>({
      pull() { throw new Error("task body must remain unread"); },
    });
    const scheduled = new Request("https://sms.example.test/api/tasks?task=send-worker", {
      method: "POST",
      headers: { "x-scheduler": "wrong" },
      body,
      duplex: "half",
    } as RequestInit);

    const response = await taskHandler.callback(scheduled);

    expect(response.status).toBe(401);
    for (const task of Object.values(taskHandler.tasks)) expect(task.runBatch).not.toHaveBeenCalled();
  });

  it("runs only the allowlisted prebound task at the configured batch limit", async () => {
    const taskHandler = handler({ batchLimit: 25 });

    const response = await taskHandler.callback(request("send-worker"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: 2, requestId: "request-123" });
    expect(taskHandler.tasks["send-worker"].runBatch).toHaveBeenCalledWith({ limit: 25 });
    for (const [name, task] of Object.entries(taskHandler.tasks)) {
      if (name !== "send-worker") expect(task.runBatch).not.toHaveBeenCalled();
    }
  });

  it("rejects unsupported task names without executing a task", async () => {
    const taskHandler = handler({});

    const response = await taskHandler.callback(new Request("https://sms.example.test/api/tasks?task=send-worker&tenantId=attacker", {
      method: "POST",
      headers: { "x-scheduler": "verified" },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid task request", retryable: false, requestId: "request-123" });
    for (const task of Object.values(taskHandler.tasks)) expect(task.runBatch).not.toHaveBeenCalled();
  });

  it("does not accept a request payload or non-POST method", async () => {
    const taskHandler = handler({});

    const payloadResponse = await taskHandler.callback(request("send-worker", "verified", "POST", '{"tenantId":"attacker"}'));
    const methodResponse = await taskHandler.callback(request("send-worker", "verified", "GET"));

    expect(payloadResponse.status).toBe(400);
    expect(methodResponse.status).toBe(405);
    for (const task of Object.values(taskHandler.tasks)) expect(task.runBatch).not.toHaveBeenCalled();
  });
});
