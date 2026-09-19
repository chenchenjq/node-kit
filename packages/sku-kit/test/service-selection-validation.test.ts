import { describe, expect, it } from "vitest";
import { createSkuService } from "../src/server/index.js";
import { createInMemorySkuStore } from "../src/testing/index.js";

describe("consumer selection validation", () => {
  it("rejects two values from the same dimension", async () => {
    const ids = ["d", "red", "blue", "s1", "s2"];
    const service = createSkuService({ store: createInMemorySkuStore(), resolveScope: async () => "scope", authorize: async () => ({ ok: true }), createId: () => ids.shift() ?? "id" });
    const saved = await service.saveConfiguration({}, { spuId: "p", spuCode: "P", commandId: "create", dimensions: [{ draftKey: "d", label: "颜色", sort: 0, values: [{ draftKey: "red", label: "红", sort: 0 }, { draftKey: "blue", label: "蓝", sort: 1 }] }], selectedCombinations: [{ pairs: [{ dimensionDraftKey: "d", valueDraftKey: "red" }] }, { pairs: [{ dimensionDraftKey: "d", valueDraftKey: "blue" }] }] });
    if (!saved.ok) throw new Error("fixture failed");
    await service.patchSkuConfigurations({}, { spuId: "p", commandId: "on", patches: saved.value.skus.map((sku) => ({ skuId: sku.skuId, expectedConfigVersion: "1", status: "enabled" })) });
    await expect(service.getConsumerSelection({}, { spuId: "p", selectedValueIds: ["red", "blue"] })).resolves.toMatchObject({ ok: false, problem: { code: "VALIDATION_FAILED" } });
  });
});
