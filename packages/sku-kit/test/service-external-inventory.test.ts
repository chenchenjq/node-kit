import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("external inventory reads", () => {
  it("returns unknown rather than inventing a quantity without an adapter", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), resolveInventoryAuthority: async () => ({ kind: "external-read-only", authorityKey: "erp" }) });
    const created = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] });
    if (!created.ok) throw new Error("fixture failed");
    const result = await service.getInventory({}, { spuId: "p", skuId: created.value.skus[0]?.skuId ?? "" });
    expect(result).toEqual({ ok: true, value: { state: "unknown", skuId: created.value.skus[0]?.skuId, reason: "外部库存适配器不可用" } });
  });
});
