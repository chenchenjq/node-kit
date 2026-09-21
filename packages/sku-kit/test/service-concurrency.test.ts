import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("concurrent initialization", () => {
  it("serializes retries for the same product and allocates only one SKU", async () => {
    let ids = 0;
    const store = createInMemorySkuStore();
    const service = createSkuService({ store, resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => `id-${++ids}` });
    const input = { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] };
    const [left, right] = await Promise.all([service.saveConfiguration({}, input), service.saveConfiguration({}, input)]);
    expect(left).toEqual(right);
    expect(left.ok && left.value.skus).toHaveLength(1);
    expect(ids).toBe(1);
  });
});
