const clone = (value) => structuredClone(value);
export const createInMemorySkuStore = () => {
    const documents = new Map();
    const authorities = new Map();
    const tails = new Map();
    const keyFor = (scopeKey, spuId) => `${scopeKey}\u0000${spuId}`;
    return {
        async transact(scopeKey, spuId, callback) {
            const key = keyFor(scopeKey, spuId);
            const previous = tails.get(key) ?? Promise.resolve();
            let release;
            const next = new Promise((resolve) => { release = resolve; });
            const queued = previous.then(() => next);
            tails.set(key, queued);
            await previous;
            try {
                const current = documents.get(key);
                const outcome = await callback(current === undefined ? null : clone(current));
                if (outcome.document !== undefined)
                    documents.set(key, clone(outcome.document));
                return outcome.result;
            }
            finally {
                release();
                if (tails.get(key) === queued)
                    tails.delete(key);
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
        async ensureInventoryAuthority(scopeKey, authority) {
            const existing = authorities.get(scopeKey);
            if (existing !== undefined && (existing.kind !== authority.kind || existing.authorityKey !== authority.authorityKey))
                return { ok: false, problem: { code: "INVENTORY_AUTHORITY_MISMATCH", message: "库存权威已绑定，不能静默修改", retryable: false } };
            authorities.set(scopeKey, clone(authority));
            return { ok: true, value: authority };
        },
        commandCount() {
            return [...documents.values()].reduce((count, document) => count + document.commands.length, 0);
        },
    };
};
