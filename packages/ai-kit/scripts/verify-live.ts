import { mkdir, writeFile } from "node:fs/promises";
import {
  createAiKit,
  createEnvironmentSecretProtector,
} from "../dist/server/index.js";
import type {
  AiStore,
  ConnectionRecord,
  StoreView,
} from "../dist/server/index.js";
import { modelPresets, providerAdapters } from "../dist/catalog.js";
import type { Plan, DictionaryItem } from "../dist/types.js";
const enabled = process.env.AI_KIT_LIVE === "1",
  selected = (process.env.AI_KIT_LIVE_PROVIDERS ?? "").split(",");
const states: Record<string, unknown> = {};
for (const preset of modelPresets) {
  const provider = preset.providerCode,
    keyName = `AI_KIT_${provider.toUpperCase()}_KEY`;
  if (!enabled || !selected.includes(provider) || !process.env[keyName]) {
    states[provider] = {
      live: "未实测",
      reason: "需要显式启用、选择厂商及独立凭据",
    };
    continue;
  }
  // Disposable, sequential CLI configuration; never a production persistence adapter.
  const connections = new Map<string, ConnectionRecord>(),
    plans = new Map<string, Plan>(),
    dictionary = new Map<string, DictionaryItem>();
  const view: StoreView = {
    getConnection: async (id) => connections.get(id) ?? null,
    listConnections: async () => [...connections.values()],
    saveConnection: async (c) => {
      connections.set(c.id, c);
    },
    deleteConnection: async (id) => {
      connections.delete(id);
    },
    getPlan: async (code) => plans.get(code) ?? null,
    listPlans: async () => [...plans.values()],
    savePlan: async (p) => {
      plans.set(p.code, p);
    },
  };
  const store: AiStore = {
    read: async (work) => work(view),
    transaction: async (work) => work(view),
  };
  const adapter = providerAdapters.find((p) => p.code === provider)!,
    baseURL =
      process.env[`AI_KIT_${provider.toUpperCase()}_URL`] ??
      adapter.endpoints[0]!.baseURL;
  try {
    const target = new URL(baseURL);
    const kit = createAiKit({
      scope: "explicit-live-test",
      store,
      secrets: createEnvironmentSecretProtector([keyName]),
      dictionary: {
        insertTypeIfAbsent: async () => {},
        insertItemIfAbsent: async (_t, v) => {
          if (!dictionary.has(v.code)) dictionary.set(v.code, v);
        },
        listItems: async () => [...dictionary.values()],
      },
      authorize: async () => true,
      rateLimit: async () => true,
      allowURL: async (url) =>
        url.origin === target.origin &&
        (url.pathname === target.pathname ||
          url.pathname.startsWith(target.pathname.replace(/\/$/, "") + "/")),
    });
    await kit.initializeDictionary(null);
    const c = await kit.saveConnection(null, {
      name: "Explicit live test",
      providerCode: provider,
      protocol: preset.protocol,
      baseURL,
      apiKey: `env:${keyName}`,
      enabled: true,
    });
    const modelId =
      process.env[`AI_KIT_${provider.toUpperCase()}_MODEL`] ?? preset.modelId;
    await kit.savePlan(null, {
      code: "live-test",
      name: "live-test",
      connectionId: c.id,
      modelId,
      enabled: true,
      isDefault: true,
      parameters: { timeoutMs: 60000, maxRetries: 0 },
    });
    const r = await kit.testPlan(null, "live-test");
    states[provider] = {
      live: r.status,
      error: r.error?.code ?? null,
      modelId: r.result?.modelId ?? modelId,
      durationMs: r.durationMs,
      usage: r.result?.usage ?? null,
    };
  } catch (error) {
    states[provider] = {
      live: "failed",
      error:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "PROVIDER_ERROR",
    };
  }
}
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../artifacts/live-status.json", import.meta.url),
  JSON.stringify(
    { at: new Date().toISOString(), enabled, providers: states },
    null,
    2,
  ),
);
console.log("Live status saved; no prompts, replies or credentials logged.");
