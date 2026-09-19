const clone = (value) => structuredClone(value);
export const createInMemorySkuStore = () => {
    const documents = new Map();
    const keyFor = (scopeKey, spuId) => `${scopeKey}\u0000${spuId}`;
    return {
        async transact(scopeKey, spuId, callback) {
            const key = keyFor(scopeKey, spuId);
            const current = documents.get(key);
            const outcome = await callback(current === undefined ? null : clone(current));
            if (outcome.document !== undefined)
                documents.set(key, clone(outcome.document));
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
