import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("incremental configuration lifecycle", () => {
  it("retains unchanged SKU identity, archives removed combinations, and allocates only new combinations", async () => {
    const ids = ["d", "red", "blue", "sku-red", "sku-blue", "green", "sku-green"];
    const store = createInMemorySkuStore();
    const service = createSkuService({ store, resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => ids.shift() ?? "id" });
    const first = await service.saveConfiguration({}, {
      spuId: "p", spuCode: "P", commandId: "first",
      dimensions: [{ draftKey: "d", label: "颜色", sort: 0, values: [{ draftKey: "red", label: "红", sort: 0 }, { draftKey: "blue", label: "蓝", sort: 1 }] }],
      selectedCombinations: [{ pairs: [{ dimensionDraftKey: "d", valueDraftKey: "red" }] }, { pairs: [{ dimensionDraftKey: "d", valueDraftKey: "blue" }] }],
    });
    if (!first.ok) throw new Error("fixture failed");

    const second = await service.saveConfiguration({}, {
      spuId: "p", spuCode: "P", commandId: "second", expectedStructureVersion: "1",
      dimensions: [{ id: "d", label: "颜色", sort: 0, values: [{ id: "red", label: "红", sort: 0 }, { draftKey: "green", label: "绿", sort: 2 }] }],
      selectedCombinations: [{ pairs: [{ dimensionId: "d", valueId: "red" }] }, { pairs: [{ dimensionId: "d", valueDraftKey: "green" }] }],
    });

    expect(second).toMatchObject({ ok: true, value: { structureVersion: "2", skus: [
      { skuId: "sku-red", skuCode: "P00" }, { skuId: "sku-green", skuCode: "P02" },
    ] } });
    const management = await service.getManagementConfiguration({}, { spuId: "p" });
    expect(management.ok && management.value.skus).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sku-blue", skuCode: "P01", archived: true, status: "archived" }),
      expect.objectContaining({ id: "sku-red", skuCode: "P00", archived: false }),
    ]));
  });
});
