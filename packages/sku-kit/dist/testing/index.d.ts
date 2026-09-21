import type { SkuStore } from "../server/contracts.js";
export declare const createInMemorySkuStore: () => SkuStore & {
    commandCount(): number;
};
