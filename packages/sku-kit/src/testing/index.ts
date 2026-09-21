import type { InventoryAuthority, ProductDocument, SkuStore } from "../server/contracts.js";
import type { Result } from "../types.js";

const clone = <T>(value: T): T => structuredClone(value);

export const createInMemorySkuStore = (): SkuStore & { commandCount(): number } => {
  const documents = new Map<string, ProductDocument>();
  const authorities = new Map<string, InventoryAuthority>();
  const tails = new Map<string, Promise<void>>();
  const keyFor = (scopeKey: string, spuId: string) => `${scopeKey}\u0000${spuId}`;
  return {
    async transact(scopeKey, spuId, callback) {
      const key = keyFor(scopeKey, spuId);
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => { release = resolve; });
      const queued = previous.then(() => next);
      tails.set(key, queued);
      await previous;
      try {
        const current = documents.get(key);
        const outcome = await callback(current === undefined ? null : clone(current));
        if (outcome.document !== undefined) documents.set(key, clone(outcome.document));
        return outcome.result;
      } finally {
        release();
        if (tails.get(key) === queued) tails.delete(key);
      }
    },
    async read(scopeKey, spuId) {
      const current = documents.get(keyFor(scopeKey, spuId));
      return current === undefined ? null : clone(current);
    },
    async findByRegisteredSpuCode(scopeKey, registeredSpuCode) {
      const document = [...documents.values()].find((candidate) => candidate.scopeKey === scopeKey && candidate.registeredSpuCode === registeredSpuCode);
      return document === undefined ? null : clone(document);
    },
    async ensureInventoryAuthority(scopeKey, authority): Promise<Result<InventoryAuthority>> {
      const existing = authorities.get(scopeKey);
      if (existing !== undefined && (existing.kind !== authority.kind || existing.authorityKey !== authority.authorityKey)) return { ok: false, problem: { code: "INVENTORY_AUTHORITY_MISMATCH", message: "库存权威已绑定，不能静默修改", retryable: false } };
      authorities.set(scopeKey, clone(authority));
      return { ok: true, value: authority };
    },
    commandCount() {
      return [...documents.values()].reduce((count, document) => count + document.commands.length, 0);
    },
  };
};
