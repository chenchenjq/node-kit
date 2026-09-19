import type { InventoryAuthority, ProductDocument, SkuStore } from "../server/contracts.js";
import type { Result } from "../types.js";

const clone = <T>(value: T): T => structuredClone(value);

export const createInMemorySkuStore = (): SkuStore & { commandCount(): number } => {
  const documents = new Map<string, ProductDocument>();
  const authorities = new Map<string, InventoryAuthority>();
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
