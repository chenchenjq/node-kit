import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("mode transition", () => {
  it("blocks default-to-multi conversion while local inventory is nonzero", async () => {
    const ids = ["sku", "dimension", "value", "next"];
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => ids.shift() ?? "id" });
    const initial = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [], selectedCombinations: [] });
    if (!initial.ok) throw new Error("fixture failed");
    await service.setLocalInventory({}, { spuId: "p", skuId: "sku", commandId: "stock", expectedInventoryVersion: "1", quantity: 1 });
    const changed = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "multi", dimensions: [{ draftKey: "d", label: "颜色", sort: 0, values: [{ draftKey: "v", label: "红", sort: 0 }] }], selectedCombinations: [{ pairs: [{ dimensionDraftKey: "d", valueDraftKey: "v" }] }] });
    expect(changed).toMatchObject({ ok: false, problem: { code: "TRANSITION_BLOCKED" } });
  });
});
