import { describe, expect, it, vi } from "vitest";

import {
  createAesGcmCredentialProtector,
  createOssKit,
} from "../dist/server/index.js";
import type { FileReference } from "../src/types.js";
import {
  credentials,
  memoryStore,
  mockOss,
  storageInput,
  strategyInput,
} from "./helpers.js";

const mockedHost = vi.hoisted(() => ({ getOssHost: vi.fn() }));
vi.mock("../examples/next/lib/host.js", () => mockedHost);

const route =
  await import("../examples/next/app/api/oss-kit/[...path]/route.js");

type Context = {
  userId: string;
  scope: string;
  admin: boolean;
  allowedStrategyCodes: readonly string[];
};
type StoredFile = {
  id: string;
  scope: string;
  ownerId: string;
  reference: FileReference;
};

function createFixture(timeoutMs = 30000) {
  let current: Context = {
    userId: "admin",
    scope: "example",
    admin: true,
    allowedStrategyCodes: [],
  };
  const files = new Map<string, StoredFile>();
  const oss = mockOss();
  const fileRepository = {
    save: vi.fn(
      async (
        scope: string,
        ownerId: string,
        reference: StoredFile["reference"],
      ) => {
        const id = `file-${files.size + 1}`;
        files.set(id, { id, scope, ownerId, reference });
        return id;
      },
    ),
    get: vi.fn(async (scope: string, id: string) =>
      files.get(id)?.scope === scope ? files.get(id)! : null,
    ),
    find: vi.fn(
      async (scope: string, reference: StoredFile["reference"]) =>
        [...files.values()].find(
          (file) =>
            file.scope === scope &&
            JSON.stringify(file.reference) === JSON.stringify(reference),
        ) ?? null,
    ),
    remove: vi.fn(async (_scope: string, id: string) => {
      files.delete(id);
    }),
  };
  const kit = createOssKit<Context>({
    timeoutMs,
    store: memoryStore(),
    applicationPrefix: "example",
    testPrefixes: ["oss-kit-test"],
    credentials: createAesGcmCredentialProtector(
      Buffer.alloc(32, 7).toString("base64"),
    ),
    ossTransportFactory: oss.factory,
    authorize: async (ctx, request) => {
      if (ctx.scope !== "example") return false;
      if (request.action === "admin") return ctx.admin;
      if (request.action === "strategy")
        return ctx.admin || ctx.allowedStrategyCodes.includes(request.code);
      const record = await fileRepository.find(ctx.scope, request.reference);
      return !!record && (ctx.admin || record.ownerId === ctx.userId);
    },
  });
  const host = {
    kit,
    scope: "example",
    files: fileRepository,
    authenticate: vi.fn(async () => current),
    protectRequest: vi.fn(async () => {}),
  };
  mockedHost.getOssHost.mockReturnValue(host);
  return {
    kit,
    host,
    files,
    setContext: (next: Context) => {
      current = next;
    },
  };
}

function context(path: string[]) {
  return { params: Promise.resolve({ path }) };
}
async function error(response: Response) {
  return (await response.json()) as {
    error: { code: string; message: string };
  };
}

describe("Next host route authorization", () => {
  it("times out and cancels a stalled Web upload stream", async () => {
    const fixture = createFixture(10);
    await fixture.kit.saveStrategy({ userId: "admin", scope: "example", admin: true, allowedStrategyCodes: [] }, strategyInput);
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { cancelled = true; } });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half", headers: { "x-oss-strategy": "attachments", "x-oss-filename": "file.txt", "content-type": "text/plain" } };
    try {
      const response = await Promise.race([route.POST(new Request("http://example.test/api/oss-kit/upload", init), context(["upload"])), new Promise<null>(resolve => setTimeout(() => resolve(null), 300))]);
      expect(response).not.toBeNull();
      expect((await error(response!)).error.code).toBe("TIMEOUT");
      expect(cancelled).toBe(true);
    } finally { if (!cancelled) controller.close(); }
  });
  it("denies a non-admin request before reading an invalid admin body", async () => {
    const fixture = createFixture();
    fixture.setContext({
      userId: "member",
      scope: "example",
      admin: false,
      allowedStrategyCodes: [],
    });
    const response = await route.POST(
      new Request("http://example.test/api/oss-kit/admin/storage", {
        method: "POST",
        body: "{not-json",
      }),
      context(["admin", "storage"]),
    );
    expect(response.status).toBe(403);
    expect(await error(response)).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "FORBIDDEN" }),
      }),
    );
    expect(fixture.host.protectRequest).toHaveBeenCalledTimes(1);
  });

  it("denies an unauthorized strategy upload without exposing credentials", async () => {
    const fixture = createFixture();
    await fixture.kit.createStorage(
      {
        userId: "admin",
        scope: "example",
        admin: true,
        allowedStrategyCodes: [],
      },
      storageInput,
      credentials,
    );
    const config = (
      await fixture.kit.listStorage({
        userId: "admin",
        scope: "example",
        admin: true,
        allowedStrategyCodes: [],
      })
    )[0]!;
    await fixture.kit.setDefaultStorage(
      {
        userId: "admin",
        scope: "example",
        admin: true,
        allowedStrategyCodes: [],
      },
      config.id,
    );
    await fixture.kit.saveStrategy(
      {
        userId: "admin",
        scope: "example",
        admin: true,
        allowedStrategyCodes: [],
      },
      strategyInput,
    );
    fixture.setContext({
      userId: "member",
      scope: "example",
      admin: false,
      allowedStrategyCodes: [],
    });
    const response = await route.POST(
      new Request("http://example.test/api/oss-kit/upload", {
        method: "POST",
        headers: {
          "x-oss-strategy": "attachments",
          "x-oss-filename": "file.txt",
          "content-type": "text/plain",
        },
        body: "hello",
      }),
      context(["upload"]),
    );
    const body = await error(response);
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });

  it("uses a stored business ID for links and rejects a different file owner", async () => {
    const fixture = createFixture();
    const admin = {
      userId: "admin",
      scope: "example",
      admin: true,
      allowedStrategyCodes: [],
    };
    const config = await fixture.kit.createStorage(
      admin,
      storageInput,
      credentials,
    );
    await fixture.kit.setDefaultStorage(admin, config.id);
    await fixture.kit.saveStrategy(admin, strategyInput);
    fixture.setContext({
      userId: "owner",
      scope: "example",
      admin: false,
      allowedStrategyCodes: ["attachments"],
    });
    const uploaded = await route.POST(
      new Request("http://example.test/api/oss-kit/upload", {
        method: "POST",
        headers: {
          "x-oss-strategy": "attachments",
          "x-oss-filename": "file.txt",
          "content-type": "text/plain",
        },
        body: "hello",
      }),
      context(["upload"]),
    );
    const { fileId } = (await uploaded.json()) as { fileId: string };
    const linked = await route.GET(
      new Request(`http://example.test/api/oss-kit/files/${fileId}/link`),
      context(["files", fileId, "link"]),
    );
    expect(linked.status).toBe(200);
    expect(fixture.host.files.get).toHaveBeenCalledWith("example", fileId);
    fixture.setContext({
      userId: "other",
      scope: "example",
      admin: false,
      allowedStrategyCodes: [],
    });
    const denied = await route.GET(
      new Request(`http://example.test/api/oss-kit/files/${fileId}/link`),
      context(["files", fileId, "link"]),
    );
    const body = await error(denied);
    expect(denied.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });
});
