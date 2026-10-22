import type {
  AiStore,
  StoreView,
  ConnectionRecord,
  AiKitOptions,
} from "../src/server/contracts.js";
import type { Plan, DictionaryItem } from "../src/types.js";
import { createEnvironmentSecretProtector } from "../src/server/secrets.js";
export interface Context {
  admin: boolean;
  allowed: string[];
  system?: boolean;
  override?: boolean;
}
export const admin: Context = {
  admin: true,
  allowed: [],
  system: true,
  override: true,
};
export function memoryStore(): AiStore {
  let connections = new Map<string, ConnectionRecord>(),
    plans = new Map<string, Plan>(),
    tail = Promise.resolve();
  function view(cs = connections, ps = plans): StoreView {
    return {
      async getConnection(id) {
        return structuredClone(cs.get(id) ?? null);
      },
      async listConnections() {
        return structuredClone([...cs.values()]);
      },
      async saveConnection(c) {
        cs.set(c.id, structuredClone(c));
      },
      async deleteConnection(id) {
        cs.delete(id);
      },
      async getPlan(code) {
        return structuredClone(ps.get(code) ?? null);
      },
      async listPlans() {
        return structuredClone([...ps.values()]);
      },
      async savePlan(p) {
        ps.set(p.code, structuredClone(p));
      },
    };
  }
  return {
    async read(work) {
      return work(view(structuredClone(connections), structuredClone(plans)));
    },
    async transaction(work) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise((r) => (release = r));
      await previous;
      const cs = structuredClone(connections),
        ps = structuredClone(plans);
      try {
        const result = await work(view(cs, ps));
        connections = cs;
        plans = ps;
        return result;
      } finally {
        release();
      }
    },
  };
}
export function dependencies(
  fetch: typeof globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "r1",
        object: "chat.completion",
        created: 1,
        model: "qwen-plus",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "OK",
              reasoning_content: "private reasoning",
            },
            finish_reason: "stop",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    ),
): AiKitOptions<Context> {
  const items = new Map<string, DictionaryItem>();
  return {
    scope: "test",
    store: memoryStore(),
    secrets: createEnvironmentSecretProtector(["AI_TEST"], () => "mock-secret"),
    dictionary: {
      async insertTypeIfAbsent() {},
      async insertItemIfAbsent(_t, v) {
        if (!items.has(v.code)) items.set(v.code, { ...v });
      },
      async listItems() {
        return [...items.values()];
      },
    },
    async authorize(ctx, r) {
      if (["admin", "test", "dictionary"].includes(r.action)) return ctx.admin;
      if (r.action === "system") return !!ctx.system;
      if (r.action === "override") return !!ctx.override;
      return ctx.admin || ("code" in r && ctx.allowed.includes(r.code));
    },
    async rateLimit() {
      return true;
    },
    async allowURL() {
      return true;
    },
    transport: {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch,
    },
  };
}
