import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("SKU configuration copy", () => {
  it("uses empty-only mode without copying inventory", async () => {
    const ids = ["d", "a", "b", "source", "target"];
    const store = createInMemorySkuStore();
    const service = createSkuService({ store, resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => ids.shift() ?? "id" });
    const saved = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [{ draftKey: "d", label: "颜色", sort: 0, values: [{ draftKey: "a", label: "红", sort: 0 }, { draftKey: "b", label: "蓝", sort: 1 }] }], selectedCombinations: [{ pairs: [{ dimensionDraftKey: "d", valueDraftKey: "a" }] }, { pairs: [{ dimensionDraftKey: "d", valueDraftKey: "b" }] }] });
    if (!saved.ok) throw new Error("fixture failed");
    await service.patchSkuConfigurations({}, { spuId: "p", commandId: "configure", patches: [{ skuId: "source", expectedConfigVersion: "1", suggestedRetailPrice: "10" }, { skuId: "target", expectedConfigVersion: "1", suggestedRetailPrice: "20" }] });
    const copied = await service.copySkuConfiguration({}, { spuId: "p", commandId: "copy", sourceSkuId: "source", targetSkuIds: ["target"], fields: ["suggestedRetailPrice"], mode: "empty-only" });
    expect(copied).toMatchObject({ ok: true, value: [{ suggestedRetailPrice: "20.00" }] });
    expect((await store.read("scope", "p"))?.inventories.target).toMatchObject({ quantity: 0, version: 1n });
  });
});
