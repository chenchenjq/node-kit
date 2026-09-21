import { describe, expect, it } from "vitest";

import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("multi-specification first save", () => {
  it("maps draft identities and creates only the selected real combinations", async () => {
    const ids = ["dimension-color", "value-red", "value-blue", "sku-red", "sku-blue"];
    const service = createSkuService({
      store: createInMemorySkuStore(),
      resolveScope: async () => "shop-a",
      authorize: async () => ({ ok: true }),
      createId: () => ids.shift() ?? "unexpected-id",
    });

    const result = await service.saveConfiguration({}, {
      spuId: "spu-shirt",
      spuCode: "SHIRT",
      commandId: "create-colors",
      dimensions: [{
        draftKey: "color",
        label: "颜色",
        sort: 0,
        values: [
          { draftKey: "red", label: "红色", sort: 0 },
          { draftKey: "blue", label: "蓝色", sort: 1 },
        ],
      }],
      selectedCombinations: [
        { pairs: [{ dimensionDraftKey: "color", valueDraftKey: "red" }] },
        { pairs: [{ dimensionDraftKey: "color", valueDraftKey: "blue" }] },
      ],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        structureVersion: "1",
        skus: [
          { skuId: "sku-red", skuCode: "SHIRT00", combinationKey: 'v1:[["dimension-color","value-red"]]', status: "disabled" },
          { skuId: "sku-blue", skuCode: "SHIRT01", combinationKey: 'v1:[["dimension-color","value-blue"]]', status: "disabled" },
        ],
        draftKeyMappings: { color: "dimension-color", red: "value-red", blue: "value-blue" },
      },
    });
  });
});
