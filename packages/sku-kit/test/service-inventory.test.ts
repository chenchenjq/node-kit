import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("local inventory command", () => {
  it("sets absolute quantity with an independent optimistic version", async () => {
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => "sku" });
    const created = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] });
    if (!created.ok) throw new Error("fixture failed");
    const skuId = created.value.skus[0]?.skuId ?? "";

    const set = await service.setLocalInventory({}, { spuId: "p", skuId, commandId: "stock", expectedInventoryVersion: "1", quantity: 7 });
    const stale = await service.setLocalInventory({}, { spuId: "p", skuId, commandId: "stale", expectedInventoryVersion: "1", quantity: 8 });

    expect(set).toEqual({ ok: true, value: { skuId: "sku", quantity: 7, inventoryVersion: "2" } });
    expect(stale).toMatchObject({ ok: false, problem: { code: "VERSION_CONFLICT" } });
  });
});
