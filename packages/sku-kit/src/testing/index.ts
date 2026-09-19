import type { ProductDocument, SkuStore } from "../server/contracts.js";

const clone = <T>(value: T): T => structuredClone(value);

export const createInMemorySkuStore = (): SkuStore & { commandCount(): number } => {
  const documents = new Map<string, ProductDocument>();
  const keyFor = (scopeKey: string, spuId: string) => `${scopeKey}\u0000${spuId}`;
  return {
    async transact(scopeKey, spuId, callback) {
      const key = keyFor(scopeKey, spuId);
      const current = documents.get(key);
      const outcome = await callback(current === undefined ? null : clone(current));
      if (outcome.document !== undefined) documents.set(key, clone(outcome.document));
      return outcome.result;
    },
    async read(scopeKey, spuId) {
      const current = documents.get(keyFor(scopeKey, spuId));
      return current === undefined ? null : clone(current);
    },
    commandCount() {
      return [...documents.values()].reduce((count, document) => count + document.commands.length, 0);
    },
  };
};
