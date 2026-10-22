// Explicit network Mock for package verification. This does not contact Alibaba Cloud.
import { Readable } from "node:stream";
export function memoryStore() {
  let configs = new Map(), strategies = new Map(), queue = Promise.resolve();
  function view(c, s) { return {
    async getStorage(id) { return structuredClone(c.get(id) ?? null); }, async listStorage() { return structuredClone([...c.values()]); }, async saveStorage(r) { c.set(r.id, structuredClone(r)); },
    async getStrategy(code) { return structuredClone(s.get(code) ?? null); }, async listStrategies() { return structuredClone([...s.values()]); }, async saveStrategy(r) { s.set(r.code, structuredClone(r)); },
  }; }
  return {
    async read(fn) { return fn(view(configs, strategies)); },
    async transaction(fn) { const previous = queue; let release; queue = new Promise(r => { release = r; }); await previous; const c = structuredClone(configs), s = structuredClone(strategies); try { const result = await fn(view(c, s)); configs = c; strategies = s; return result; } finally { release(); } },
  };
}
export function mockOss() {
  const objects = new Map();
  return { objects, factory(storage) {
    const location = key => `${storage.id}/${key}`;
    return {
      async put(key, data) { if (objects.has(location(key))) throw Object.assign(new Error("exists"), { code: "FileAlreadyExists" }); objects.set(location(key), Buffer.from(data)); },
      async get(key) { const b = objects.get(location(key)); if (!b) throw new Error("missing"); return b; },
      async read(key) { const b = objects.get(location(key)); if (!b) throw new Error("missing"); return Readable.from([b]); },
      async delete(key) { objects.delete(location(key)); },
      async sign(key, expires) { return `https://${storage.bucket}.${storage.region}.aliyuncs.com/${key}?x-oss-expires=${expires}&x-oss-signature=MOCK`; },
    };
  } };
}
