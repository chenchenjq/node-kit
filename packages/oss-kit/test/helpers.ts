import { Readable } from "node:stream";
import type { OssStore, StoreView, StorageRecord, Strategy, Credentials } from "../src/types.js";
import type { OssTransportFactory } from "../src/server/aliyun.js";
export function memoryStore(): OssStore {
  let configs = new Map<string, StorageRecord>();
  let strategies = new Map<string, Strategy>();
  let queue = Promise.resolve();
  const view = (c: typeof configs, s: typeof strategies): StoreView => ({
    async getStorage(id) { return structuredClone(c.get(id) ?? null); },
    async listStorage() { return structuredClone([...c.values()]); },
    async saveStorage(r) { c.set(r.id, structuredClone(r)); },
    async getStrategy(code) { return structuredClone(s.get(code) ?? null); },
    async listStrategies() { return structuredClone([...s.values()]); },
    async saveStrategy(r) { s.set(r.code, structuredClone(r)); },
  });
  return {
    async read(fn) { return fn(view(configs, strategies)); },
    async transaction(fn) {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>(r => { release = r; });
      await previous;
      const c = structuredClone(configs), s = structuredClone(strategies);
      try { const result = await fn(view(c, s)); configs = c; strategies = s; return result; }
      finally { release(); }
    },
  };
}
export function mockOss() {
  const objects = new Map<string, Buffer>();
  const seenCredentials: Credentials[] = [];
  const failures: { put?: Error; get?: Error; delete?: Error } = {};
  const factory: OssTransportFactory = (config, credentials) => {
    seenCredentials.push(structuredClone(credentials));
    const path = (key: string) => `${config.id}/${key}`;
    return {
      async put(key, data) { if (failures.put) throw failures.put; if (objects.has(path(key))) throw Object.assign(new Error("exists"), { code: "FileAlreadyExists" }); objects.set(path(key), data); },
      async get(key) { if (failures.get) throw failures.get; const content = objects.get(path(key)); if (!content) throw new Error("missing"); return content; },
      async read(key) { const content = objects.get(path(key)); if (!content) throw new Error("missing"); return Readable.from([content]); },
      async delete(key) { if (failures.delete) throw failures.delete; objects.delete(path(key)); },
      async sign(key, seconds) { return `https://${config.bucket}.${config.region}.aliyuncs.com/${key}?x-oss-expires=${seconds}&x-oss-signature=MOCK`; },
    };
  };
  return { factory, objects, seenCredentials, failures };
}
export const credentials: Credentials = { accessKeyId: "test-id", accessKeySecret: "test-secret" };
export const storageInput = { name: "Test storage", region: "oss-cn-hangzhou", bucket: "test-bucket" };
export const strategyInput = { code: "attachments", name: "附件", description: "需宿主创建", prefix: "attachments", allowedExtensions: ["txt"], allowedMimeTypes: ["text/plain"] };
