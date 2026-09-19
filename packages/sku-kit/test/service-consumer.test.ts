import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("consumer selection projection", () => {
  it("returns only exact selected SKU and marks host-unselectable values", async () => {
    const ids = ["d-color", "v-red", "v-blue", "sku-red", "sku-blue"];
    const service = createSkuService({
      store: createInMemorySkuStore(), resolveScope: async () => "shop-a", authorize: async () => ({ ok: true }),
      createId: () => ids.shift() ?? "id",
      projectConsumer: async (skus) => skus.map((sku) => ({
        skuId: sku.id,
        visible: true,
        selectable: sku.id === "sku-red",
        salePrice: sku.id === "sku-red" ? "19.90" : null,
        availability: sku.id === "sku-red" ? "in-stock" : "out-of-stock",
      })),
    });
    const created = await service.saveConfiguration({}, {
      spuId: "shirt", spuCode: "SHIRT", commandId: "create",
      dimensions: [{ draftKey: "color", label: "颜色", sort: 0, values: [{ draftKey: "red", label: "红色", sort: 0 }, { draftKey: "blue", label: "蓝色", sort: 1 }] }],
      selectedCombinations: [{ pairs: [{ dimensionDraftKey: "color", valueDraftKey: "red" }] }, { pairs: [{ dimensionDraftKey: "color", valueDraftKey: "blue" }] }],
    });
    if (!created.ok) throw new Error("fixture creation failed");
    await service.patchSkuConfigurations({}, {
      spuId: "shirt", commandId: "enable", patches: created.value.skus.map((sku) => ({ skuId: sku.skuId, expectedConfigVersion: "1", status: "enabled" })),
    });
    await service.patchSkuConfigurations({}, { spuId: "shirt", commandId: "image", patches: [{ skuId: "sku-red", expectedConfigVersion: "2", image: { adapter: "oss", value: "sku-red" } }] });

    const partial = await service.getConsumerSelection({}, { spuId: "shirt", selectedValueIds: [] });
    const complete = await service.getConsumerSelection({}, { spuId: "shirt", selectedValueIds: ["v-red"], spuImage: { adapter: "oss", value: "spu" } });

    expect(partial).toMatchObject({ ok: true, value: { selectedSku: null, priceRange: { status: "partial", min: "19.90", max: "19.90" } } });
    expect(partial.ok && partial.value.dimensions[0]?.options).toEqual([
      expect.objectContaining({ valueId: "v-red", state: "selectable" }),
      expect.objectContaining({ valueId: "v-blue", state: "out-of-stock" }),
    ]);
    expect(complete).toMatchObject({ ok: true, value: { selectedSku: { skuId: "sku-red", salePrice: "19.90" }, image: { adapter: "oss", value: "sku-red" } } });
  });
});
