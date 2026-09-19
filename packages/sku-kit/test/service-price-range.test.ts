import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("consumer price range", () => {
  it("uses only SKUs still reachable from the partial selection", async () => {
    const ids = ["d1", "a", "b", "d2", "x", "y", "s1", "s2", "s3", "s4"];
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => ids.shift() ?? "id", projectConsumer: async (skus) => skus.map((sku) => ({ skuId: sku.id, visible: true, selectable: true, salePrice: sku.id === "s1" || sku.id === "s2" ? "100.00" : "1.00", availability: "in-stock" })) });
    const pairs: Array<[string, string]> = [["a", "x"], ["a", "y"], ["b", "x"], ["b", "y"]];
    const saved = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [{ draftKey: "d1", label: "A", sort: 0, values: [{ draftKey: "a", label: "a", sort: 0 }, { draftKey: "b", label: "b", sort: 1 }] }, { draftKey: "d2", label: "X", sort: 1, values: [{ draftKey: "x", label: "x", sort: 0 }, { draftKey: "y", label: "y", sort: 1 }] }], selectedCombinations: pairs.map(([valueDraftKey, second]) => ({ pairs: [{ dimensionDraftKey: "d1", valueDraftKey }, { dimensionDraftKey: "d2", valueDraftKey: second }] })) });
    if (!saved.ok) throw new Error("fixture failed");
    await service.patchSkuConfigurations({}, { spuId: "p", commandId: "on", patches: saved.value.skus.map((sku) => ({ skuId: sku.skuId, expectedConfigVersion: "1", status: "enabled" })) });
    const result = await service.getConsumerSelection({}, { spuId: "p", selectedValueIds: ["a"] });
    expect(result).toMatchObject({ ok: true, value: { priceRange: { status: "complete", min: "100.00", max: "100.00" } } });
  });
});
